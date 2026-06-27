"""Student handlers: add/remove a student in a lab's shared container.

Storage model: there are no per-student ZFS datasets. A lab has a single fast `users` dataset and a
single slow `users` dataset (each bind-mounted into the container), both covered by the lab's fast/
slow quota. A student is just a plain subdir under those mounts, created *inside* the container
by ``users.add_user``. Because the parent ``users`` mounts are already UID-shifted by Sysbox, the
in-container ``mkdir``/``chown`` work without privilege; nothing is created on the host here.
There is intentionally no per-student quota — usage is bounded by the lab quota alone.
"""

from __future__ import annotations

from typing import Any

from .config import AgentConfig
from .executors import docker, users


def add_student(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    username = params["username"]
    password = params["password"]

    # No host-side dataset creation: add_user makes the student's scratch/cold-storage subdirs under
    # the already-shifted /labusers mounts inside the container, so the chown succeeds. (The old
    # per-student ZFS datasets appeared inside the userns as an unmapped UID and could not be
    # chowned by container-root — the "Operation not permitted" failure this replaces.)
    users.add_user(docker.container_name(lab), username, password)
    return {"lab": lab, "username": username}, f"added student '{username}' to lab '{lab}'"


def remove_student(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    username = params["username"]
    delete_data = bool(params.get("delete_data", False))

    # When delete_data is set, remove_user also wipes the student's /labusers/{fast,slow} subdirs
    # inside the container. There are no per-student datasets to destroy on the host.
    users.remove_user(docker.container_name(lab), username, delete_home=delete_data)
    msg = f"removed student '{username}' from lab '{lab}'"
    return {"lab": lab, "username": username, "data_deleted": delete_data}, msg
