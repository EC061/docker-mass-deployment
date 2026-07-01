"""Heartbeat telemetry collection.

Reports, every heartbeat:
  - pool free space (ZFS pools, plus the SMB cold-storage mount when that backend is used),
  - per-dataset usage under the lab roots (the controller maps dataset names back to labs/students
    and stores a storage time-series),
  - ZFS scrub status per pool (so the controller can alert when a scrub finds errors),
  - the live GPU process list (pid + VRAM, resolved to container/user where possible).

Storage usage is **not** measured on the heartbeat: the lab-level totals (fast/slow ZFS + container
writable-layer "image") come from the lab-usage cache (refreshed every ``lab_usage_interval_s``, see
``usagereport.collect_lab_level``) and the per-student ``du`` breakdown from the scan cache. The
heartbeat just re-reports whichever cached numbers are current, so a 15s heartbeat never triggers an
expensive ``zfs list`` / ``docker inspect`` / ``du``.

The controller stores the latest snapshot; GPU is snapshot-only (no time-series).
"""

from __future__ import annotations

from typing import Any

from . import coldstore, usagereport
from .config import AgentConfig
from .executors import zfs
from .executors.base import run
from .gpu.monitor import list_gpu_processes


def _pool_free(pool: str) -> dict[str, Any] | None:
    res = run(["zpool", "list", "-Hp", "-o", "name,size,alloc,free", pool], timeout=15)
    if not res.ok or not res.stdout.strip():
        return None
    parts = res.stdout.split()
    if len(parts) < 4:
        return None
    return {"name": parts[0], "size": int(parts[1]), "alloc": int(parts[2]), "free": int(parts[3])}


def _pools(cfg: AgentConfig) -> list[dict[str, Any]]:
    # Only ZFS pools this node owns. On the SMB cold-storage backend the slow pool lives on (and is
    # reported by) the owner node, so it is excluded here.
    zfs_pools = [cfg.fast_pool] + ([cfg.slow_pool] if cfg.slow_is_zfs else [])
    return [info for p in zfs_pools if (info := _pool_free(p)) is not None]


def _storage_usage(cfg: AgentConfig, usage_state: Any = None) -> list[dict[str, Any]]:
    if usage_state is None:
        return []
    out: list[dict[str, Any]] = []
    # Lab-level totals: the container writable-layer ("image") plus lab-level fast/slow ZFS
    # usage-vs-quota. Sourced from the lab-usage cache (refreshed every ``lab_usage_interval_s`` /
    # on-demand), so the heartbeat re-reports the last computed snapshot — it does not re-measure.
    for level in usage_state.all_lab_level().values():
        out.extend(level.storage)
    # Per-student breakdown from the scan cache: each student's fast home and cold ``du``. Updated
    # only by the nightly / on-demand scan, so the
    # heartbeat just re-reports the cached numbers — they change on disk only when a scan reruns.
    for lab, usage in usage_state.all_container().items():
        out.extend(usagereport.tier_storage(lab, usage))
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
        "scrub": [zfs.scrub_status(p).to_dict() for p in cfg.scrub_pools],
        "cold": coldstore.cold_status(cfg),
        "gpu_processes": list_gpu_processes(),
        "usage_scans": _usage_scans(usage_state),
    }
