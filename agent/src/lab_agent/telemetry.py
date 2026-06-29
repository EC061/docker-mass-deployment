"""Heartbeat telemetry collection.

Reports, every heartbeat:
  - pool free space (ZFS pools, plus the SMB cold-storage mount when that backend is used),
  - per-dataset usage under the lab roots (the controller maps dataset names back to labs/students
    and stores a storage time-series),
  - ZFS scrub status per pool (so the controller can alert when a scrub finds errors),
  - the live GPU process list (pid + VRAM, resolved to container/user where possible).

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


def _dataset_usage(cfg: AgentConfig, docker_state: Any = None) -> list[dict[str, Any]]:
    out = []
    labs: set[str] = set()
    for u in zfs.list_usage(cfg.labs_fast_root):
        out.append(
            {
                "pool": "fast",
                "dataset": u.dataset,
                "used_bytes": u.used_bytes,
                "quota_bytes": u.quota_bytes,
                "available_bytes": u.available_bytes,
            }
        )
        parsed = usagereport._parse_dataset(u.dataset, cfg.labs_fast_root)
        if parsed is not None and parsed[1] is None:  # lab-level row -> a lab to measure
            labs.add(parsed[0])
    out.extend(coldstore.list_usage(cfg))
    if docker_state is not None:
        labs |= set(docker_state.all_docker().keys())
    # Container-level usage: the whole-container writable layer (pool="docker", lab level), measured
    # LIVE every heartbeat (one cheap ``docker inspect --size`` per lab) so the Stats page's
    # whole-image number is always current rather than frozen until the next scan.
    for lab in sorted(labs):
        row = usagereport.live_docker_dataset(lab)
        if row is not None:
            out.append(row)
    # Per-student breakdown from the (expensive) scan cache: each student's docker home (installed
    # software) plus their scratch/cold ``du``. Updated only by the nightly / on-demand scan, so the
    # heartbeat just re-reports the cached numbers — they change on disk only when a scan reruns.
    if docker_state is not None:
        for lab, usage in docker_state.all_docker().items():
            out.extend(usagereport.docker_datasets(lab, usage))
            out.extend(usagereport.tier_datasets(lab, usage))
    return out


def _usage_scans(docker_state: Any = None) -> list[dict[str, Any]]:
    """Per-lab timestamp of the last per-student usage (``du``) scan, so the controller can show
    data freshness and decide whether an on-demand re-scan is warranted."""
    if docker_state is None:
        return []
    return [
        {"lab": lab, "scanned_at": usage.scanned_at}
        for lab, usage in docker_state.all_docker().items()
        if usage.scanned_at is not None
    ]


def collect_heartbeat(cfg: AgentConfig, docker_state: Any = None) -> dict[str, Any]:
    return {
        "pools": _pools(cfg),
        "datasets": _dataset_usage(cfg, docker_state),
        "scrub": [zfs.scrub_status(p).to_dict() for p in cfg.scrub_pools],
        "gpu_processes": list_gpu_processes(),
        "usage_scans": _usage_scans(docker_state),
    }
