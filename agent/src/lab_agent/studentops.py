"""Create exact-ID accounts and conditional per-student storage datasets.

Quota-disabled placements retain the original host-owned directories. A placement with a student
quota uses a direct child dataset for that tier, mounted at the same path.
"""

from __future__ import annotations

import os
import shutil
from typing import Any

from . import coldstore
from .config import AgentConfig
from .executors import coldfs, docker, users, zfs
from .executors.base import run
from .paths import lab_fast, user_fast, user_slow


def _ensure_user_dataset(dataset: str, path: str, quota: int | None, uid: int, gid: int) -> None:
    """Create/promote a student directory only when quota mode is enabled.

    With quota unset and no existing child dataset this intentionally does nothing, preserving the
    original flat lab dataset. Promotion is called while the lab container is stopped by recreate.
    """
    if zfs.dataset_exists(dataset):
        zfs.set_quota(dataset, quota)
        coldfs.ensure_owned_dir(path, uid, gid)
        return
    if quota is None:
        coldfs.ensure_owned_dir(path, uid, gid)
        return
    staged = f"{path}.student-quota-migration"
    had_data = os.path.exists(path)
    if os.path.exists(staged):
        raise RuntimeError(f"stale student quota migration path exists: {staged}")
    if had_data:
        os.rename(path, staged)
    try:
        zfs.create_dataset(dataset, quota_bytes=quota, mountpoint=path)
        if had_data:
            copied = run(["cp", "-a", f"{staged}/.", path], timeout=3600)
            if not copied.ok:
                raise RuntimeError(f"could not copy student data into quota dataset: {copied.logs}")
        coldfs.ensure_owned_dir(path, uid, gid)
        if had_data:
            shutil.rmtree(staged)
    except Exception:
        if zfs.dataset_exists(dataset):
            zfs.destroy_dataset(dataset, recursive=True)
        if had_data and os.path.exists(staged):
            if os.path.isdir(path) and not os.listdir(path):
                os.rmdir(path)
            os.rename(staged, path)
        raise


def prepare_student_storage(cfg: AgentConfig, lab: str, username: str, uid: int, gid: int,
                            fast_quota: int | None, cold_quota: int | None) -> None:
    users.validate_username(username)
    for label, value in (("fast", fast_quota), ("cold", cold_quota)):
        invalid = value is not None and (
            not isinstance(value, int) or isinstance(value, bool) or value <= 0
        )
        if invalid:
            raise ValueError(f"student {label} quota must be a positive integer byte count")
    fast_root = zfs.get_mountpoint(lab_fast(cfg, lab))
    _ensure_user_dataset(user_fast(cfg, lab, username), f"{fast_root}/{username}",
                         fast_quota, uid, gid)
    cold_root = coldstore.lab_mount(cfg, lab)
    if cfg.slow_is_zfs:
        _ensure_user_dataset(user_slow(cfg, lab, username), f"{cold_root}/{username}",
                             cold_quota, uid, gid)
    else:
        coldfs.ensure_owned_dir(f"{cold_root}/{username}", uid, gid)


def add_student(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    username = params["username"]
    password = params["password"]
    uid = int(params["uid"])
    gid = int(params.get("gid", uid))
    users.validate_username(username)
    users.validate_uid(uid, gid)

    # Managed labs use --userns=host, so persistent storage has identical host/container IDs.
    host_uid = uid
    host_gid = gid
    prepare_student_storage(
        cfg, lab, username, host_uid, host_gid,
        params.get("student_fast_quota_bytes"), params.get("student_cold_quota_bytes"),
    )

    # The directories already have the student's stable IDs; account creation populates the home
    # and creates its cold-storage symlink.
    users.add_user(docker.container_name(lab, cfg.node_name), username, password, uid, gid)
    users.verify_ssh_login(docker.container_name(lab, cfg.node_name), username, password)
    return {"lab": lab, "username": username, "uid": uid, "ssh_verified": True}, (
        f"added student '{username}' (uid={uid}) to lab '{lab}'; initial SSH login verified"
    )


def remove_student(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    username = params["username"]
    delete_data = bool(params.get("delete_data", False))
    users.remove_user(docker.container_name(lab, cfg.node_name), username)
    if delete_data:
        dataset = user_fast(cfg, lab, username)
        if zfs.dataset_exists(dataset):
            zfs.destroy_dataset(dataset, recursive=True)
        else:
            coldfs.remove_child(zfs.get_mountpoint(lab_fast(cfg, lab)), username)
    msg = f"removed student '{username}' from lab '{lab}'"
    result = {
        "lab": lab,
        "username": username,
        "data_deleted": delete_data,
        "cold_deleted": False,
    }
    return result, msg


def delete_cold_student(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Owner-only final cleanup after all containers have removed the student account."""
    if not cfg.slow_is_zfs:
        raise coldfs.ColdFsError("an SMB client may not delete shared cold-storage data")
    lab = params["lab"]
    username = params["username"]
    users.validate_username(username)
    dataset = user_slow(cfg, lab, username)
    if zfs.dataset_exists(dataset):
        zfs.destroy_dataset(dataset, recursive=True)
    else:
        coldfs.remove_child(coldstore.lab_mount(cfg, lab), username)
    return {"lab": lab, "username": username, "cold_deleted": True}, (
        f"deleted cold storage for '{username}' in lab '{lab}'"
    )
