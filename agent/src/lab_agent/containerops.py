"""Container provisioning handlers: create the lab container, and recreate it on option changes.

Recreate preserves all data: lab/student data lives in bind-mounted ZFS datasets, not in the
container's writable layer, so removing + recreating the container keeps everything.
"""

from __future__ import annotations

from typing import Any

from .config import AgentConfig
from .executors import docker, zfs
from .executors.docker import ContainerOptions, Mounts
from .paths import lab_fast_shared, lab_fast_users, lab_slow_shared, lab_slow_users
from .system import detect_capabilities


def _mounts(cfg: AgentConfig, lab: str) -> Mounts:
    return Mounts(
        fast_shared=zfs.get_mountpoint(lab_fast_shared(cfg, lab)),
        slow_shared=zfs.get_mountpoint(lab_slow_shared(cfg, lab)),
        fast_users=zfs.get_mountpoint(lab_fast_users(cfg, lab)),
        slow_users=zfs.get_mountpoint(lab_slow_users(cfg, lab)),
    )


def ensure_container(cfg: AgentConfig, lab: str, params: dict[str, Any]) -> str:
    """Create the lab container fresh (removing any existing one first)."""
    name = docker.container_name(lab)
    opts = ContainerOptions.from_params(params)
    mounts = _mounts(cfg, lab)
    caps = detect_capabilities(cfg)
    docker.remove_container(name)
    return docker.create_container(
        name,
        opts,
        mounts,
        gpus=caps.nvidia_runtime and caps.nvidia_gpu,
    )


def recreate_container(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Dispatcher handler for container.recreate. Data is preserved (lives in datasets)."""
    lab = params["lab"]
    container_id = ensure_container(cfg, lab, params)
    return {"lab": lab, "container": container_id}, f"recreated container for lab '{lab}'"
