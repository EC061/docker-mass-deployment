"""Shared fixtures for storage-aware agent tests.

``make_cfg`` is the ergonomic constructor the tests use instead of the old flat ``fast_pool=`` /
``slow_pool=`` keyword arguments: those scalars are still accepted in ``config.toml`` (see
``config.load_config``) but the agent's internal model is now ``cfg.storage``.
"""

from __future__ import annotations

from dataclasses import replace

from lab_agent.config import AgentConfig
from lab_agent.storage.model import (
    BACKEND_MERGERFS,
    BACKEND_SMB,
    BACKEND_ZFS,
    StorageConfig,
    legacy_storage,
)


def make_storage(
    *,
    fast_pools: list[str] | None = None,
    cold_pools: list[str] | None = None,
    cold_backend: str | None = None,
    slow_path: str = "/cold-storage",
    fast_mount_root: str = "/fast",
    cold_mount_root: str = "/cold-storage",
    docker_pool: str | None = None,
    branch_root: str = "/mnt/lab-storage",
) -> StorageConfig:
    fast_pools = fast_pools or ["fast"]
    cold_pools = cold_pools or ["slow"]
    cold_backend = cold_backend or (
        BACKEND_MERGERFS if len(cold_pools) > 1 else BACKEND_ZFS
    )
    storage = legacy_storage(
        fast_pool=fast_pools[0],
        slow_pool=cold_pools[0],
        slow_backend=BACKEND_SMB if cold_backend == BACKEND_SMB else BACKEND_ZFS,
        slow_path=slow_path,
        fast_mount_root=fast_mount_root,
        cold_mount_root=cold_mount_root,
        docker_pool=docker_pool,
    )
    fast = replace(storage.fast, branch_root=branch_root).with_pools(tuple(fast_pools))
    storage = storage.with_tier(fast)
    if cold_backend != BACKEND_SMB:
        cold = replace(storage.cold, branch_root=branch_root).with_pools(tuple(cold_pools))
        storage = storage.with_tier(cold)
    return storage.validate()


def make_cfg(**kwargs) -> AgentConfig:
    """An AgentConfig with a storage topology built from keyword shorthands."""
    storage_keys = {
        "fast_pools", "cold_pools", "cold_backend", "slow_path", "fast_mount_root",
        "cold_mount_root", "docker_pool", "branch_root",
    }
    storage_kwargs = {k: kwargs.pop(k) for k in list(kwargs) if k in storage_keys}
    kwargs.setdefault("controller_url", "ws://x")
    kwargs.setdefault("token", "t")
    cfg = AgentConfig(**kwargs)
    cfg.storage = make_storage(**storage_kwargs)
    return cfg
