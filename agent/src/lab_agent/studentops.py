"""Create exact-ID student accounts and their host-owned fast/cold directories."""

from __future__ import annotations

from typing import Any

from . import coldstore
from .config import AgentConfig
from .executors import coldfs, docker, users, zfs
from .paths import lab_fast


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
    fast_root = zfs.get_mountpoint(lab_fast(cfg, lab))
    cold_root = coldstore.lab_mount(cfg, lab)
    coldfs.ensure_owned_dir(f"{fast_root}/{username}", host_uid, host_gid)
    coldfs.ensure_owned_dir(f"{cold_root}/{username}", host_uid, host_gid)

    # The directories already have the student's stable IDs; account creation populates the home
    # and creates its cold-storage symlink.
    users.add_user(docker.container_name(lab, cfg.node_name), username, password, uid, gid)
    return {"lab": lab, "username": username, "uid": uid}, (
        f"added student '{username}' (uid={uid}) to lab '{lab}'"
    )


def remove_student(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    username = params["username"]
    delete_data = bool(params.get("delete_data", False))
    users.remove_user(docker.container_name(lab, cfg.node_name), username)
    if delete_data:
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
    coldfs.remove_child(coldstore.lab_mount(cfg, lab), username)
    return {"lab": lab, "username": username, "cold_deleted": True}, (
        f"deleted cold storage for '{username}' in lab '{lab}'"
    )
