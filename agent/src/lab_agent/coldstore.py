"""Slow-tier ("cold storage") operations with a pluggable backend.

The fast tier is always ZFS. The slow tier can be either:
  * zfs — a local ZFS pool on this node: full dataset/quota/usage/scrub control (delegates to the
          zfs executor).
  * smb — an SMB/CIFS mount of a slow ZFS pool that lives on **another** node. This node is a pure
          client: it makes the per-lab/per-student directories on the share (so its containers have
          a bind-mount source) and exposes the mount paths, but it does **not** monitor cold storage
          — no quotas, no usage telemetry, no scrubs. The node that physically owns the pool runs
          the zfs backend and does all of that for the same data.

Callers (labops, studentops, containerops, telemetry) go through this module for everything
on the slow tier so the backend choice lives in exactly one place. Usage is always returned as a
``zfs.Usage`` so the rest of the agent treats both backends uniformly.
"""

from __future__ import annotations

from typing import Any

from . import paths
from .config import AgentConfig
from .executors import coldfs, zfs
from .executors.zfs import Usage

# --------------------------------------------------------------------------- provisioning


def create_lab(cfg: AgentConfig, lab: str, quota_bytes: int | None = None) -> str:
    """Provision a lab's cold-storage datasets/directories. Returns a short log note."""
    if cfg.slow_is_zfs:
        zfs.create_dataset(paths.lab_slow(cfg, lab), quota_bytes=quota_bytes)
        zfs.create_dataset(paths.lab_slow_shared(cfg, lab))
        zfs.create_dataset(paths.lab_slow_users(cfg, lab))
        return "slow datasets created (zfs)"
    # SMB client: create the directories on the share so containers can bind-mount them. The owner
    # node manages quotas/usage for the same data.
    coldfs.ensure_dir(paths.cold_lab(cfg, lab))
    coldfs.ensure_dir(paths.cold_lab_shared(cfg, lab))
    coldfs.ensure_dir(paths.cold_lab_users(cfg, lab))
    return "slow directories created (smb client; owner node manages quota/usage)"


def set_lab_quota(cfg: AgentConfig, lab: str, quota_bytes: int | None) -> str:
    if cfg.slow_is_zfs:
        zfs.set_quota(paths.lab_slow(cfg, lab), quota_bytes)
        return f"slow quota -> {quota_bytes}"
    return "slow quota set on the owner node (cold storage is SMB here)"


def destroy_lab(cfg: AgentConfig, lab: str) -> None:
    if cfg.slow_is_zfs:
        zfs.destroy_dataset(paths.lab_slow(cfg, lab), recursive=True)
    else:
        coldfs.remove_tree(paths.cold_lab(cfg, lab), guard=cfg.cold_root)


# --------------------------------------------------------------------------- mounts (for docker)


def shared_mount(cfg: AgentConfig, lab: str) -> str:
    """Host path bind-mounted to /labdata/slow in the lab container."""
    if cfg.slow_is_zfs:
        return zfs.get_mountpoint(paths.lab_slow_shared(cfg, lab))
    return paths.cold_lab_shared(cfg, lab)


def users_mount(cfg: AgentConfig, lab: str) -> str:
    """Host path bind-mounted to /labusers/slow in the lab container."""
    if cfg.slow_is_zfs:
        return zfs.get_mountpoint(paths.lab_slow_users(cfg, lab))
    return paths.cold_lab_users(cfg, lab)


# --------------------------------------------------------------------------- usage
# On the SMB backend this node does not monitor cold storage — the owner node (zfs) reports usage
# and scrubs the same data. So the usage helpers return "nothing here".


def lab_usage(cfg: AgentConfig, lab: str) -> Usage:
    if cfg.slow_is_zfs:
        return zfs.get_usage(paths.lab_slow(cfg, lab))
    # SMB client: not measured locally (the owner node reports it).
    return Usage(paths.cold_lab(cfg, lab), 0, None, None)


def list_usage(cfg: AgentConfig) -> list[dict[str, Any]]:
    """Per-lab/per-student slow-tier usage for telemetry. Empty on the SMB client backend."""
    if not cfg.slow_is_zfs:
        return []
    return [
        {
            "pool": "slow",
            "dataset": u.dataset,
            "used_bytes": u.used_bytes,
            "quota_bytes": u.quota_bytes,
            "available_bytes": u.available_bytes,
        }
        for u in zfs.list_usage(cfg.labs_slow_root)
    ]
