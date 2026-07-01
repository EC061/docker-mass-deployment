"""Container provisioning handlers: create the lab container, and recreate it on option changes.

Recreate preserves all data: lab/student data lives in bind-mounted ZFS datasets, not in the
container's writable layer, so removing + recreating the container keeps everything.
"""

from __future__ import annotations

from typing import Any

from . import coldstore, maintenance_state, usagereport
from .config import AgentConfig
from .executors import docker, zfs
from .executors.docker import ContainerOptions, Mounts
from .paths import lab_fast
from .system import detect_capabilities


# Docker labels stamped on every lab container. lab-agent.managed=true is the authoritative signal
# the GPU killer uses to decide a container is ours — host processes and unmanaged containers carry
# no such label and are therefore never eligible to be warned or killed.
def _labels(cfg: AgentConfig, lab: str) -> dict[str, str]:
    return {
        "lab-agent.managed": "true",
        "lab-agent.lab": lab,
        "lab-agent.node": cfg.node_name,
        # Docker compiles seccomp policy at container creation. A profile file updated later does
        # not change an existing container, so stamp the exact policy for doctor to compare.
        "lab-agent.seccomp-sha256": docker.security_profile_digest(cfg.seccomp_profile),
        # This creation-time Docker option removes /proc overmounts that prevent bubblewrap from
        # mounting the procfs for its PID namespace. Doctor uses the label to reject old labs.
        "lab-agent.systempaths-unconfined": "true",
    }


def _mounts(cfg: AgentConfig, lab: str) -> Mounts:
    # ensure_labquota_dirs creates the root-owned status dir on the host before container start,
    # so the read-only /run/labquota bind has a source.
    return Mounts(
        fast=zfs.get_mountpoint(lab_fast(cfg, lab)),
        cold=coldstore.lab_mount(cfg, lab),
        labquota=usagereport.ensure_labquota_dirs(cfg, lab),
        seccomp_profile=cfg.seccomp_profile,
        apparmor_profile=cfg.apparmor_profile,
    )


def assert_node_ready(cfg: AgentConfig) -> Any:
    caps = detect_capabilities(cfg, deep=False)
    runtime_ok = (
        caps.runtime.docker_ok and caps.runtime.userns_ok and caps.runtime.nested_userns_ok
    )
    if not runtime_ok or caps.health.status == "critical":
        raise docker.DockerError(
            "node runtime/storage is unhealthy; run `lab-agent doctor` before changing labs"
        )
    return caps


def ensure_container(cfg: AgentConfig, lab: str, params: dict[str, Any]) -> str:
    """Create the lab container fresh and verify that sshd becomes ready."""
    name = docker.container_name(lab)
    opts = ContainerOptions.from_params(params)
    mounts = _mounts(cfg, lab)
    caps = assert_node_ready(cfg)
    # Pull before removing the old container: mutable tags such as :latest must resolve to the
    # newest registry image, and a registry failure must leave the existing container untouched.
    docker.ensure_image(opts.image)
    docker.remove_container(name)
    # GPUs are attached directly to the outer runc container through CDI.
    container_id = docker.create_container(
        name,
        opts,
        mounts,
        gpus=caps.nvidia_gpu and caps.nvidia_cdi,
        labels=_labels(cfg, lab),
    )
    if not docker.wait_ssh_ready(name):
        logs = docker.container_logs(name)
        docker.remove_container(name)
        detail = f": {logs}" if logs else ""
        raise docker.DockerError(f"container did not become ready (SSH handshake failed){detail}")
    return container_id


def recreate_container(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Dispatcher handler for container.recreate, with rollback. Data is preserved (it lives in the
    bind-mounted ZFS datasets, not the container's writable layer).

    Flow that never leaves the lab without a working container on failure:
      1. Validate + ensure the proposed image is available BEFORE stopping the running container.
      2. Stop the old container and rename it aside (lab-<lab>-old) — preserved for rollback.
      3. Create the candidate under the real name and wait for sshd readiness.
      4. On success, delete the preserved old container (promote). On any failure, remove the
         candidate and restore + restart the old container, then surface the error.
    """
    lab = params["lab"]
    name = docker.container_name(lab)
    old = f"{name}-old"
    opts = ContainerOptions.from_params(params)
    mounts = _mounts(cfg, lab)
    caps = assert_node_ready(cfg)
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
        container_id = docker.create_container(
            name, opts, mounts, gpus=gpus, labels=_labels(cfg, lab)
        )
        if not docker.wait_ssh_ready(name):
            logs = docker.container_logs(name)
            detail = f": {logs}" if logs else ""
            raise docker.DockerError(
                f"candidate container did not become ready (SSH handshake failed){detail}"
            )
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
