"""Cold-tier ("cold storage") operations with a pluggable backend.

The cold tier can be:

  * **zfs**       one local ZFS pool on this node: full dataset/quota/usage/scrub control.
  * **mergerfs**  N local ZFS pools on this node, unioned per lab. Same control, more disks.
  * **smb**       an SMB/CIFS mount of cold storage that lives on **another** node. This node is a
                  pure client: it makes the per-lab/per-student directories on the share (so its
                  containers have a bind-mount source) and exposes the mount paths, but it does
                  **not** monitor cold storage — no quotas, no usage telemetry, no scrubs. The node
                  that physically owns the pools runs zfs/mergerfs and does all of that for the same
                  data.

Nothing changes for an SMB client when the owner grows from one cold pool to several: the owner's
``/cold-storage/<lab>`` is still one directory tree (a mergerfs union instead of a plain dataset),
the share is still exported from ``/cold-storage``, and the client still sees exactly the same
interface. An SMB client never learns about, and can never touch, the owner's pools or quotas.

Callers (labops, studentops, containerops, telemetry) go through this module for everything on the
cold tier so the backend choice lives in exactly one place.
"""

from __future__ import annotations

import os
from typing import Any

from . import paths
from .config import AgentConfig
from .executors import coldfs, zfs
from .executors.zfs import Usage
from .storage import service
from .storage.model import TIER_COLD

# --------------------------------------------------------------------------- provisioning


def create_lab(cfg: AgentConfig, lab: str, quota_bytes: int | None = None) -> str:
    """Provision a lab's cold-storage datasets/directories. Returns a short log note."""
    if cfg.slow_is_zfs:
        result = service.provision_lab(cfg, TIER_COLD, lab, quota_bytes)
        return f"cold lab storage ready ({cfg.slow_backend}) at {result['mountpoint']}"
    # SMB client: require the owner-created lab root on the mounted share. Creating it here could
    # silently make an ordinary directory instead of the owner's quota-bearing storage.
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
    if not cfg.slow_is_zfs:
        return "cold quota set on the owner node (cold storage is SMB here)"
    result = service.set_lab_quota(cfg, TIER_COLD, lab, quota_bytes)
    split = ", ".join(f"{p}={q}" for p, q in sorted(result.get("allocation", {}).items()))
    return f"cold quota -> {quota_bytes} ({split or 'no branch'})"


def destroy_lab(cfg: AgentConfig, lab: str, *, force: bool = False) -> None:
    if cfg.slow_is_zfs:
        service.destroy_lab(cfg, TIER_COLD, lab, force=force)
        return
    # Never remove shared storage from a client. The controller tears clients down first and
    # only the local owner may destroy the backing datasets.
    return


# --------------------------------------------------------------------------- mounts (for docker)


def lab_mount(cfg: AgentConfig, lab: str) -> str:
    """Host path bind-mounted to /cold-storage in the lab container.

    Identical for every backend: ``/cold-storage/<lab>``. On an owner it is a ZFS dataset or a
    mergerfs union of one dataset per pool; on a client it is a path on the SMB mount.
    """
    if cfg.slow_is_zfs:
        return service.mount_lab(cfg, TIER_COLD, lab)
    if not os.path.ismount(cfg.slow_path):
        raise coldfs.ColdFsError(
            f"cold-storage SMB mount '{cfg.slow_path}' is not mounted; refusing fallback directory"
        )
    return paths.cold_lab(cfg, lab)


# --------------------------------------------------------------------------- usage
# On the SMB backend this node does not monitor cold storage — the owner node reports usage
# and scrubs the same data. So the usage helpers return "nothing here".


def lab_usage(cfg: AgentConfig, lab: str) -> Usage:
    """One aggregated cold-tier usage row for the lab (summed across branches, never doubled)."""
    if not cfg.slow_is_zfs:
        # SMB client: not measured locally (the owner node reports it).
        return Usage(paths.cold_lab(cfg, lab), 0, None, None)
    tier = cfg.storage.cold
    branches = service.observe_branches(tier, lab)
    agg = service.aggregate(TIER_COLD, lab, branches)
    return Usage(tier.logical_mount(lab), agg.used_bytes, agg.quota_bytes, agg.available_bytes)


def cold_status(cfg: AgentConfig) -> dict[str, Any]:
    """Cold-storage backend + mount state for the controller's Nodes page / SMB-assignment checks.

    An owner reports the tier mount root and is ready when every configured pool's container dataset
    is mounted where it should be (``healthy``), or reports ``degraded`` when only some are. An SMB
    client reports its mount root and whether it is an ACTIVE mount point (so the controller can
    block provisioning onto a client whose share is not actually mounted).
    """
    if cfg.slow_is_zfs:
        tier = cfg.storage.cold
        health, healths = service.tier_health(tier)
        return {
            "backend": tier.backend,
            "mount_path": tier.mount_root,
            "ready": health != service.HEALTH_UNAVAILABLE,
            "health": health,
            "pools": [h.to_dict() for h in healths],
        }
    # Lab directories live directly below the SMB mount. Report whether it is active so the
    # controller can refuse to provision onto an unmounted SMB client.
    root = cfg.slow_path
    ready = bool(root) and os.path.ismount(root)
    return {
        "backend": "smb",
        "mount_path": root,
        "ready": ready,
        "health": service.HEALTH_HEALTHY if ready else service.HEALTH_UNAVAILABLE,
        "pools": [],
    }


__all__ = [
    "cold_status",
    "coldfs",
    "create_lab",
    "destroy_lab",
    "lab_mount",
    "lab_usage",
    "os",
    "set_lab_quota",
    "zfs",
]
