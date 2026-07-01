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

import os
from typing import Any

from . import paths
from .config import AgentConfig
from .executors import coldfs, zfs
from .executors.zfs import Usage

# --------------------------------------------------------------------------- provisioning


def create_lab(cfg: AgentConfig, lab: str, quota_bytes: int | None = None) -> str:
    """Provision a lab's cold-storage datasets/directories. Returns a short log note."""
    if cfg.slow_is_zfs:
        zfs.create_dataset(
            paths.lab_slow(cfg, lab), quota_bytes=quota_bytes,
            mountpoint=paths.cold_lab(cfg, lab),
        )
        return "cold lab dataset created (zfs)"
    # SMB client: require the owner-created lab root on the mounted share. Creating it here could
    # silently make an ordinary directory instead of the owner's quota-bearing ZFS dataset.
    if not os.path.ismount(cfg.slow_path):
        raise coldfs.ColdFsError(
            f"cold-storage SMB mount '{cfg.slow_path}' is not mounted; refusing fallback directory"
        )
    path = paths.cold_lab(cfg, lab)
    try:
        os.lstat(path)
    except FileNotFoundError as exc:
        raise coldfs.ColdFsError(
            f"owner cold-storage directory '{path}' does not exist; provision the owner first"
        ) from exc
    if not os.path.isdir(path) or os.path.islink(path):
        raise coldfs.ColdFsError(f"refusing cold-storage path '{path}': expected a real directory")
    return "owner cold lab directory verified (smb client; owner manages quota/usage)"


def set_lab_quota(cfg: AgentConfig, lab: str, quota_bytes: int | None) -> str:
    if cfg.slow_is_zfs:
        zfs.set_quota(paths.lab_slow(cfg, lab), quota_bytes)
        return f"slow quota -> {quota_bytes}"
    return "slow quota set on the owner node (cold storage is SMB here)"


def destroy_lab(cfg: AgentConfig, lab: str) -> None:
    if cfg.slow_is_zfs:
        zfs.destroy_dataset(paths.lab_slow(cfg, lab), recursive=True)
    else:
        # Never remove shared storage from a client. The controller tears clients down first and
        # only the local-ZFS owner may destroy the backing dataset.
        return


# --------------------------------------------------------------------------- mounts (for docker)


def lab_mount(cfg: AgentConfig, lab: str) -> str:
    """Host path bind-mounted to /cold-storage in the lab container."""
    if cfg.slow_is_zfs:
        return zfs.get_mountpoint(paths.lab_slow(cfg, lab))
    if not os.path.ismount(cfg.slow_path):
        raise coldfs.ColdFsError(
            f"cold-storage SMB mount '{cfg.slow_path}' is not mounted; refusing fallback directory"
        )
    return paths.cold_lab(cfg, lab)


# --------------------------------------------------------------------------- usage
# On the SMB backend this node does not monitor cold storage — the owner node (zfs) reports usage
# and scrubs the same data. So the usage helpers return "nothing here".


def lab_usage(cfg: AgentConfig, lab: str) -> Usage:
    if cfg.slow_is_zfs:
        return zfs.get_usage(paths.lab_slow(cfg, lab))
    # SMB client: not measured locally (the owner node reports it).
    return Usage(paths.cold_lab(cfg, lab), 0, None, None)


def cold_status(cfg: AgentConfig) -> dict[str, Any]:
    """Cold-storage backend + mount state for the controller's Nodes page / SMB-assignment checks.

    A local-ZFS owner reports the cold lab-root mountpoint and is ready only at the configured
    path. An SMB client reports its mount root and whether it is an ACTIVE mount point (so the
    controller can block provisioning onto a client whose share is not actually mounted).
    """
    if cfg.slow_is_zfs:
        try:
            mount = zfs.get_mountpoint(cfg.labs_slow_root)
        except Exception:
            mount = None
        ready = bool(mount) and os.path.realpath(mount) == os.path.realpath(cfg.cold_mount_root)
        return {"backend": "zfs", "mount_path": mount, "ready": ready}
    # Lab directories live directly below the slow_path mount. Report whether it is active so the
    # controller can refuse to provision onto an unmounted SMB client.
    root = cfg.slow_path
    return {"backend": "smb", "mount_path": root, "ready": bool(root) and os.path.ismount(root)}
