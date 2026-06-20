"""Heartbeat telemetry collection.

Phase 1 reports liveness + pool free space. Phase 2 extends this with per-lab/student
`zfs used,quota` and the live GPU process list. The controller stores the latest snapshot
(and a storage time-series).
"""

from __future__ import annotations

from typing import Any

from .config import AgentConfig
from .executors.base import run


def _pool_free(pool: str) -> dict[str, Any] | None:
    res = run(["zpool", "list", "-Hp", "-o", "name,size,alloc,free", pool], timeout=15)
    if not res.ok or not res.stdout.strip():
        return None
    parts = res.stdout.split()
    if len(parts) < 4:
        return None
    return {"name": parts[0], "size": int(parts[1]), "alloc": int(parts[2]), "free": int(parts[3])}


def collect_heartbeat(cfg: AgentConfig) -> dict[str, Any]:
    pools = []
    for pool in (cfg.fast_pool, cfg.slow_pool):
        info = _pool_free(pool)
        if info is not None:
            pools.append(info)
    return {"pools": pools}
