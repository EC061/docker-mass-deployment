"""Container provisioning handlers: create the lab container, and recreate it on option changes.

Recreate preserves all data: lab/student data lives in bind-mounted ZFS datasets, not in the
container's writable layer, so removing + recreating the container keeps everything.
"""

from __future__ import annotations

from typing import Any

from . import coldstore, maintenance_state
from .config import AgentConfig
from .executors import docker, zfs
from .executors.docker import ContainerOptions, Mounts
from .paths import lab_fast_shared, lab_fast_users
from .system import detect_capabilities


def _mounts(cfg: AgentConfig, lab: str) -> Mounts:
    return Mounts(
        fast_shared=zfs.get_mountpoint(lab_fast_shared(cfg, lab)),
        slow_shared=coldstore.shared_mount(cfg, lab),
        fast_users=zfs.get_mountpoint(lab_fast_users(cfg, lab)),
        slow_users=coldstore.users_mount(cfg, lab),
    )


def ensure_container(cfg: AgentConfig, lab: str, params: dict[str, Any]) -> str:
    """Create the lab container fresh (removing any existing one first)."""
    name = docker.container_name(lab)
    opts = ContainerOptions.from_params(params)
    mounts = _mounts(cfg, lab)
    caps = detect_capabilities(cfg)
    docker.remove_container(name)
    # GPUs are attached via CDI under the sysbox runtime, so a node needs both a GPU and a generated
    # CDI spec; without the spec we launch GPU-less rather than fall back to an incompatible runtime
    # (the missing spec is surfaced as a capability issue in the hello frame / `lab-agent doctor`).
    return docker.create_container(
        name,
        opts,
        mounts,
        gpus=caps.nvidia_gpu and caps.nvidia_cdi,
    )


def recreate_container(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Dispatcher handler for container.recreate. Data is preserved (lives in datasets)."""
    lab = params["lab"]
    container_id = ensure_container(cfg, lab, params)
    # A recreated container has a fresh writable layer = the unpatched pinned base image. Clear the
    # apt-upgrade record so the weekly package loop re-patches it on its next tick instead of
    # waiting up to a full interval.
    maintenance_state.mark_unpatched(cfg, lab)
    return {"lab": lab, "container": container_id}, f"recreated container for lab '{lab}'"
