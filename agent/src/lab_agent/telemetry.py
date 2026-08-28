"""Heartbeat telemetry collection.

Reports, every heartbeat:
  - free space and health for EVERY ZFS pool this node owns, each tagged with the tier(s) it backs
    (so the controller never has to guess from position which pool is "fast" and which is "cold"),
  - per-tier logical health (healthy / degraded / unavailable) plus exactly which pool is broken,
  - per-lab usage under the lab roots, already aggregated across branches into one logical number
    per lab per tier (the controller maps lab names back to placements and stores a time-series),
  - ZFS scrub status per owned pool (so the controller can alert when a scrub finds errors),
  - the live GPU process list (pid + VRAM, resolved to container/user where possible).

Storage usage is **not** measured on the heartbeat: the lab-level totals (fast/cold ZFS + container
writable-layer "image") come from the lab-usage cache (refreshed every ``lab_usage_interval_s``, see
``usagereport.collect_lab_level``) and the per-student ``du`` breakdown from the scan cache. The
heartbeat just re-reports whichever cached numbers are current, so a 15s heartbeat never triggers an
expensive ``zfs list`` / ``docker inspect`` / ``du``.

The full storage inventory (devices, per-lab branch quotas, mergerfs state) is deliberately NOT on
the heartbeat — it is far too big for a 15 s cadence. The controller pulls it on demand with the
``storage.status`` task.
"""

from __future__ import annotations

from typing import Any

from . import coldstore, usagereport
from .config import AgentConfig
from .executors import zfs
from .gpu.monitor import list_gpu_processes
from .storage import service


def _pool_free(cfg: AgentConfig, pool: str) -> dict[str, Any] | None:
    """Capacity + health for one owned pool, tagged with the tier(s) it backs."""
    capacity = zfs.pool_capacity(pool)
    if capacity is None:
        return {
            "name": pool, "size": 0, "alloc": 0, "free": 0,
            "health": "UNAVAIL", "imported": False, "tiers": cfg.storage.tiers_for_pool(pool),
        }
    return {
        "name": capacity.name,
        "size": capacity.size,
        "alloc": capacity.alloc,
        "free": capacity.free,
        "health": capacity.health,
        "imported": True,
        "tiers": cfg.storage.tiers_for_pool(pool),
    }


def _pools(cfg: AgentConfig) -> list[dict[str, Any]]:
    # Only ZFS pools this node owns. On the SMB cold-storage backend the cold pools live on (and are
    # reported by) the owner node, so they are excluded by ``owned_pools``.
    return [info for p in cfg.scrub_pools if (info := _pool_free(cfg, p)) is not None]


def _storage_usage(cfg: AgentConfig, usage_state: Any = None) -> list[dict[str, Any]]:
    if usage_state is None:
        return []
    out: list[dict[str, Any]] = []
    # Lab-level totals: the container writable-layer ("image") plus lab-level fast/cold usage-vs-
    # quota, already summed across branches. Sourced from the lab-usage cache (refreshed every
    # ``lab_usage_interval_s`` / on-demand), so the heartbeat re-reports the last computed snapshot.
    for level in usage_state.all_lab_level().values():
        out.extend(level.storage)
    live_students = {(r.get("lab"), r.get("user"), r.get("tier")) for r in out if r.get("user")}
    # Per-student breakdown from the scan cache: each student's fast home and cold ``du``, measured
    # once through the LOGICAL lab path. Updated only by the nightly / on-demand scan, so the
    # heartbeat just re-reports the cached numbers.
    for lab, usage in usage_state.all_container().items():
        out.extend(r for r in usagereport.tier_storage(lab, usage)
                   if (r.get("lab"), r.get("user"), r.get("tier")) not in live_students)
    return out


def _usage_scans(usage_state: Any = None) -> list[dict[str, Any]]:
    """Per-lab timestamp of the last per-student usage (``du``) scan, so the controller can show
    data freshness and decide whether an on-demand re-scan is warranted."""
    if usage_state is None:
        return []
    return [
        {"lab": lab, "scanned_at": usage.scanned_at}
        for lab, usage in usage_state.all_container().items()
        if usage.scanned_at is not None
    ]


def collect_heartbeat(cfg: AgentConfig, usage_state: Any = None) -> dict[str, Any]:
    return {
        "pools": _pools(cfg),
        "storage": _storage_usage(cfg, usage_state),
        "storage_tiers": service.tier_summaries(cfg),
        "scrub": [zfs.scrub_status(p).to_dict() for p in cfg.scrub_pools],
        "cold": coldstore.cold_status(cfg),
        "gpu_processes": list_gpu_processes(),
        "usage_scans": _usage_scans(usage_state),
    }
