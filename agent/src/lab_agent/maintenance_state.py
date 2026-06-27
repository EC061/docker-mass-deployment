"""Persistent per-lab maintenance bookkeeping (currently: last successful in-container apt upgrade).

A tiny JSON file next to the agent's state DB (``cfg.maintenance_state``) records, per lab, the
epoch-ms of the last successful ``apt-get upgrade`` run inside that lab's container. The weekly
package-update loop (see ``client._pkg_update_loop``) reads it on every tick and only patches a lab
whose record is older than the configured interval — or absent. This makes the weekly cadence
anacron-style: a window missed while the agent or node was down is caught up on the next tick, and
the schedule survives restarts (it lives on disk, not in memory).

Writes are atomic (``.tmp`` + ``os.replace``) and the file is treated as a best-effort cache: a
corrupt or unreadable file is read as empty, so a bad write never wedges the loop — the affected
labs are simply reconsidered next tick. This mirrors the durable-but-disposable pattern in
``usagereport``.
"""

from __future__ import annotations

import json
import os
from typing import Any

from .config import AgentConfig
from .protocol import now_ms

# Per-lab record key: epoch-ms of the last successful apt upgrade.
LAST_APT_UPGRADE = "last_apt_upgrade_at"


def _load(cfg: AgentConfig) -> dict[str, Any]:
    try:
        with open(cfg.maintenance_state, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _save(cfg: AgentConfig, data: dict[str, Any]) -> None:
    path = cfg.maintenance_state
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)


def last_apt_upgrade(cfg: AgentConfig, lab: str) -> int | None:
    """Epoch-ms of the last recorded successful apt upgrade for ``lab``, or None if never."""
    entry = _load(cfg).get(lab)
    if isinstance(entry, dict) and isinstance(entry.get(LAST_APT_UPGRADE), int):
        return entry[LAST_APT_UPGRADE]
    return None


def all_apt_upgrades(cfg: AgentConfig) -> dict[str, int]:
    """Map of lab -> last-apt-upgrade epoch-ms for every lab with a record (for `doctor`)."""
    out: dict[str, int] = {}
    for lab, entry in _load(cfg).items():
        if isinstance(entry, dict) and isinstance(entry.get(LAST_APT_UPGRADE), int):
            out[lab] = entry[LAST_APT_UPGRADE]
    return out


def record_apt_upgrade(cfg: AgentConfig, lab: str, *, when: int | None = None) -> None:
    """Record a successful apt upgrade for ``lab`` (defaults to now)."""
    data = _load(cfg)
    entry = data.get(lab)
    if not isinstance(entry, dict):
        entry = {}
        data[lab] = entry
    entry[LAST_APT_UPGRADE] = when if when is not None else now_ms()
    _save(cfg, data)


def mark_unpatched(cfg: AgentConfig, lab: str) -> None:
    """Reset a lab's apt-upgrade record to epoch 0 (e.g. after recreate) so it is due next tick."""
    record_apt_upgrade(cfg, lab, when=0)


def is_due(cfg: AgentConfig, lab: str, interval_s: int, *, now: int | None = None) -> bool:
    """True if ``lab`` has never been patched or its last patch is older than ``interval_s``."""
    last = last_apt_upgrade(cfg, lab)
    if last is None:
        return True
    now = now if now is not None else now_ms()
    return (now - last) >= interval_s * 1000
