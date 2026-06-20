"""Slow-tier ("cold storage") operations with a pluggable backend.

The fast tier is always ZFS. The slow tier can be either:
  * zfs — a local ZFS pool: full dataset/quota control (delegates to the zfs executor).
  * smb — an externally-managed SMB/CIFS mount, possibly shared between two nodes: directories
          instead of datasets, no enforceable quota, usage via du/statvfs, never scrubbed.

Callers (labops, studentops, containerops, scan, telemetry) go through this module for everything
on the slow tier so the backend choice lives in exactly one place. Usage is always returned as a
``zfs.Usage`` so the rest of the agent treats both backends uniformly.
"""

from __future__ import annotations

import os
import time
from typing import Any

from . import paths
from .config import AgentConfig
from .executors import coldfs, zfs
from .executors.zfs import Usage

# du over SMB is expensive, so cache lab/user usage and recompute at most this often. The
# controller throttles storage samples far below this, so hourly granularity is plenty.
_DU_TTL_S = 3600.0
_du_cache: dict[str, tuple[float, int]] = {}


def _du_cached(path: str, *, now: float | None = None) -> int | None:
    now = now if now is not None else time.time()
    hit = _du_cache.get(path)
    if hit and now - hit[0] < _DU_TTL_S:
        return hit[1]
    val = coldfs.du_bytes(path)
    if val is not None:
        _du_cache[path] = (now, val)
    return val


# --------------------------------------------------------------------------- provisioning


def create_lab(cfg: AgentConfig, lab: str, quota_bytes: int | None = None) -> str:
    """Provision a lab's cold-storage datasets/directories. Returns a short log note."""
    if cfg.slow_is_zfs:
        zfs.create_dataset(paths.lab_slow(cfg, lab), quota_bytes=quota_bytes)
        zfs.create_dataset(paths.lab_slow_shared(cfg, lab))
        zfs.create_dataset(paths.lab_slow_users(cfg, lab))
        return "slow datasets created (zfs)"
    coldfs.ensure_dir(paths.cold_lab(cfg, lab))
    coldfs.ensure_dir(paths.cold_lab_shared(cfg, lab))
    coldfs.ensure_dir(paths.cold_lab_users(cfg, lab))
    return "slow directories created (smb; quota not enforced)"


def set_lab_quota(cfg: AgentConfig, lab: str, quota_bytes: int | None) -> str:
    if cfg.slow_is_zfs:
        zfs.set_quota(paths.lab_slow(cfg, lab), quota_bytes)
        return f"slow quota -> {quota_bytes}"
    return "slow quota not enforced (cold storage is SMB)"


def create_user(cfg: AgentConfig, lab: str, user: str, quota_bytes: int | None = None) -> None:
    if cfg.slow_is_zfs:
        zfs.create_dataset(paths.user_cold(cfg, lab, user), quota_bytes=quota_bytes)
    else:
        coldfs.ensure_dir(paths.cold_user(cfg, lab, user))


def destroy_lab(cfg: AgentConfig, lab: str) -> None:
    if cfg.slow_is_zfs:
        zfs.destroy_dataset(paths.lab_slow(cfg, lab), recursive=True)
    else:
        coldfs.remove_tree(paths.cold_lab(cfg, lab), guard=cfg.cold_root)


def destroy_user(cfg: AgentConfig, lab: str, user: str) -> None:
    if cfg.slow_is_zfs:
        zfs.destroy_dataset(paths.user_cold(cfg, lab, user), recursive=True)
    else:
        coldfs.remove_tree(paths.cold_user(cfg, lab, user), guard=cfg.cold_root)


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


# --------------------------------------------------------------------------- usage + scanning


def lab_usage(cfg: AgentConfig, lab: str) -> Usage:
    if cfg.slow_is_zfs:
        return zfs.get_usage(paths.lab_slow(cfg, lab))
    path = paths.cold_lab(cfg, lab)
    used = _du_cached(path) or 0
    _size, free = coldfs.disk_free(path)
    return Usage(path, used, None, free)


def list_usage(cfg: AgentConfig) -> list[dict[str, Any]]:
    """Per-lab/per-student slow-tier usage for telemetry (pool field is always 'slow')."""
    if cfg.slow_is_zfs:
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
    # SMB: walk <root>/labs/<lab> and <root>/labs/<lab>/users/<user> with cached du.
    out: list[dict[str, Any]] = []
    root = cfg.cold_root
    if not os.path.isdir(root):
        return out
    _size, free = coldfs.disk_free(root)
    for lab in sorted(_listdirs(root)):
        lab_path = os.path.join(root, lab)
        out.append(_smb_row(lab_path, free))
        users_path = os.path.join(lab_path, "users")
        for user in sorted(_listdirs(users_path)):
            out.append(_smb_row(os.path.join(users_path, user), free))
    return out


def _smb_row(path: str, free: int | None) -> dict[str, Any]:
    return {
        "pool": "slow",
        "dataset": path,
        "used_bytes": _du_cached(path) or 0,
        "quota_bytes": None,
        "available_bytes": free,
    }


def _listdirs(path: str) -> list[str]:
    if not os.path.isdir(path):
        return []
    try:
        return [e for e in os.listdir(path) if os.path.isdir(os.path.join(path, e))]
    except OSError:
        return []


def shared_scan_dir(cfg: AgentConfig, lab: str) -> str | None:
    """Existing directory holding a lab's shared cold data, or None."""
    if cfg.slow_is_zfs:
        return _zfs_scan_dir(paths.lab_slow_shared(cfg, lab))
    return _existing_dir(paths.cold_lab_shared(cfg, lab))


def user_scan_dir(cfg: AgentConfig, lab: str, user: str) -> str | None:
    """Existing directory holding a student's cold data, or None."""
    if cfg.slow_is_zfs:
        return _zfs_scan_dir(paths.user_cold(cfg, lab, user))
    return _existing_dir(paths.cold_user(cfg, lab, user))


def _zfs_scan_dir(dataset: str) -> str | None:
    if not zfs.dataset_exists(dataset):
        return None
    mp = zfs.get_mountpoint(dataset)
    return _existing_dir(mp)


def _existing_dir(path: str | None) -> str | None:
    if not path or path in ("none", "legacy") or not os.path.isdir(path):
        return None
    return path


# --------------------------------------------------------------------------- pool free space


def pool_free(cfg: AgentConfig) -> dict[str, Any] | None:
    """Cold-storage free space for telemetry, for the SMB backend (zfs uses zpool list)."""
    if cfg.slow_is_zfs:
        return None
    size, free = coldfs.disk_free(cfg.slow_path)
    if size is None:
        return None
    return {
        "name": cfg.slow_path,
        "size": size,
        "alloc": size - (free or 0),
        "free": free or 0,
        "backend": "smb",
        "shared": cfg.slow_shared,
    }
