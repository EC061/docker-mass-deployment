"""Heartbeat telemetry collection.

Reports, every heartbeat:
  - pool free space,
  - per-dataset usage under the lab roots (the controller maps dataset names back to labs/students
    and stores a storage time-series),
  - the live GPU process list (pid + VRAM, resolved to container/user where possible).

The controller stores the latest snapshot; GPU is snapshot-only (no time-series).
"""

from __future__ import annotations

from typing import Any

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


def _dataset_usage(cfg: AgentConfig) -> list[dict[str, Any]]:
    out = []
    for pool, root in (("fast", cfg.labs_fast_root), ("slow", cfg.labs_slow_root)):
        for u in zfs.list_usage(root):
            out.append(
                {
                    "pool": pool,
                    "dataset": u.dataset,
                    "used_bytes": u.used_bytes,
                    "quota_bytes": u.quota_bytes,
                    "available_bytes": u.available_bytes,
                }
            )
    return out


def collect_heartbeat(cfg: AgentConfig) -> dict[str, Any]:
    pools = [
        info for pool in (cfg.fast_pool, cfg.slow_pool) if (info := _pool_free(pool)) is not None
    ]
    return {
        "pools": pools,
        "datasets": _dataset_usage(cfg),
        "gpu_processes": list_gpu_processes(),
    }
