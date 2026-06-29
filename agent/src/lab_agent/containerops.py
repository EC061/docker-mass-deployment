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
    """Dispatcher handler for container.recreate, with rollback. Data is preserved (it lives in the
    bind-mounted ZFS datasets, not the container's writable layer).

    Flow that never leaves the lab without a working container on failure:
      1. Validate + ensure the proposed image is available BEFORE stopping the running container.
      2. Stop the old container and rename it aside (lab-<lab>-old) — preserved for rollback.
      3. Create the candidate under the real name and wait for systemd/sshd readiness.
      4. On success, delete the preserved old container (promote). On any failure, remove the
         candidate and restore + restart the old container, then surface the error.
    """
    lab = params["lab"]
    name = docker.container_name(lab)
    old = f"{name}-old"
    opts = ContainerOptions.from_params(params)
    mounts = _mounts(cfg, lab)
    caps = detect_capabilities(cfg)
    gpus = caps.nvidia_gpu and caps.nvidia_cdi

    # 1. Fail early if the image is bad/unavailable — the working container is still untouched.
    docker.ensure_image(opts.image)

    had_old = docker.container_exists(name)
    if had_old:
        # 2. Preserve the current container aside (clear any stale -old first).
        docker.stop_container(name)
        docker.remove_container(old)
        docker.rename_container(name, old)

    try:
        # 3. Bring up the candidate under the real name and verify it actually started.
        container_id = docker.create_container(name, opts, mounts, gpus=gpus)
        if not docker.wait_systemd_ready(name):
            raise docker.DockerError("candidate container did not become ready (sshd not active)")
    except Exception as exc:
        # 4a. Roll back: drop the broken candidate and restore the preserved container.
        try:
            docker.remove_container(name)
        except docker.DockerError:
            pass
        if had_old and docker.container_exists(old):
            docker.rename_container(old, name)
            docker.start_container(name)
        raise docker.DockerError(
            f"recreate failed for lab '{lab}', rolled back to the previous container: {exc}"
        ) from exc

    # 4b. Promote: remove the preserved old container now the candidate is confirmed healthy.
    if had_old:
        docker.remove_container(old)

    # A recreated container has a fresh writable layer = the unpatched pinned base image. Clear the
    # apt-upgrade record so the weekly package loop re-patches it on its next tick.
    maintenance_state.mark_unpatched(cfg, lab)
    return {"lab": lab, "container": container_id}, f"recreated container for lab '{lab}'"
