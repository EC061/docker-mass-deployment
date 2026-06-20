"""Student handlers: add/remove a student in a lab's shared container.

Adding a student creates their per-student ZFS datasets (scratch on fast, cold-storage on slow),
applies any optional sub-quota, then creates the Linux user + symlinks inside the container.
"""

from __future__ import annotations

from typing import Any

from . import coldstore
from .config import AgentConfig
from .executors import docker, users, zfs
from .paths import user_scratch


def add_student(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    username = params["username"]
    password = params["password"]
    scratch_quota = params.get("scratch_quota_bytes")
    cold_quota = params.get("cold_quota_bytes")

    # Per-student datasets appear under the container's bind-mounted users parents. Scratch is
    # always ZFS; cold storage goes through coldstore (ZFS or SMB).
    zfs.create_dataset(user_scratch(cfg, lab, username), quota_bytes=scratch_quota)
    coldstore.create_user(cfg, lab, username, cold_quota)

    users.add_user(docker.container_name(lab), username, password)
    return {"lab": lab, "username": username}, f"added student '{username}' to lab '{lab}'"


def remove_student(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    username = params["username"]
    delete_data = bool(params.get("delete_data", False))

    users.remove_user(docker.container_name(lab), username, delete_home=delete_data)
    if delete_data:
        zfs.destroy_dataset(user_scratch(cfg, lab, username), recursive=True)
        coldstore.destroy_user(cfg, lab, username)
    msg = f"removed student '{username}' from lab '{lab}'"
    return {"lab": lab, "username": username, "data_deleted": delete_data}, msg
