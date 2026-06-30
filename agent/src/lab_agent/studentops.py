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

    host_uid = cfg.userns_start + uid
    host_gid = cfg.userns_start + gid
    fast_root = zfs.get_mountpoint(lab_fast(cfg, lab))
    cold_root = coldstore.lab_mount(cfg, lab)
    coldfs.ensure_owned_dir(f"{fast_root}/{username}", host_uid, host_gid)
    coldfs.ensure_owned_dir(f"{cold_root}/{username}", host_uid, host_gid)

    # The directories already have the daemon-remapped host IDs; the in-container account receives
    # the matching stable IDs and only creates home-directory symlinks.
    users.add_user(docker.container_name(lab), username, password, uid, gid)
    return {"lab": lab, "username": username, "uid": uid}, (
        f"added student '{username}' (uid={uid}) to lab '{lab}'"
    )


def remove_student(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    username = params["username"]
    delete_data = bool(params.get("delete_data", False))
    # delete_cold is sent separately by the controller: True only for the local-ZFS owner of the
    # cold data (so shared cold is deleted exactly once), False on SMB clients (which must never
    # touch the owner's share). Defaults to delete_data for a standalone local-ZFS lab / old caller.
    delete_cold = bool(params.get("delete_cold", delete_data))

    users.remove_user(docker.container_name(lab), username)
    if delete_data:
        coldfs.remove_child(zfs.get_mountpoint(lab_fast(cfg, lab)), username)
    if delete_cold:
        coldfs.remove_child(coldstore.lab_mount(cfg, lab), username)
    msg = f"removed student '{username}' from lab '{lab}'"
    result = {
        "lab": lab,
        "username": username,
        "data_deleted": delete_data,
        "cold_deleted": delete_cold,
    }
    return result, msg
