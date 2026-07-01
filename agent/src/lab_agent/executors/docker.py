"""Docker executor for the single, non-nested lab container.

One shared container per lab (name ``lab-<lab>``). Creation-time options (cpu/ram/shm/image-quota/
port/restart) are baked into ``docker run`` and frozen for the container's life; changing them means
``recreate`` (which preserves the ZFS data, since data lives in bind-mounted datasets, not the
container layer). All NVIDIA GPUs are always passed.

The persistent mounts are the lab's fast root at ``/home`` and cold root at ``/cold-storage``, plus
read-only agent-published quota snapshot at ``/run/labquota``. There is no lab-side engine or
host Docker socket.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from .base import CommandResult, run

# A docker image reference: optional registry/host, repo path, optional :tag and/or @sha256 digest.
# Crucially it must not start with '-' (which docker would read as a flag) and contains no spaces.
IMAGE_RE = re.compile(
    r"^[a-zA-Z0-9][a-zA-Z0-9._/-]*(:[a-zA-Z0-9._-]+)?(@sha256:[a-f0-9]{64})?$"
)
# Environment variable names: conventional shell identifiers only.
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class DockerError(RuntimeError):
    pass


def validate_image(image: str) -> str:
    if not IMAGE_RE.match(image) or len(image) > 256:
        raise DockerError(f"invalid image reference '{image}'")
    return image


def sanitize_env(env: dict) -> dict[str, str]:
    """Keep only well-formed env keys with bounded, newline-free values (L-10)."""
    out: dict[str, str] = {}
    for key, value in env.items():
        if not isinstance(key, str) or not ENV_KEY_RE.match(key):
            continue
        sval = str(value).replace("\n", "").replace("\r", "")[:1024]
        out[key] = sval
    return out


def container_name(lab: str) -> str:
    return f"lab-{lab}"


@dataclass
class ContainerOptions:
    image: str = "ghcr.io/ec061/custom-ssh:latest"
    cpus: str = "4"
    memory: str = "8g"
    shm_size: str = "1g"
    rootfs_quota: str = "300g"  # outer container writable-layer quota
    ssh_port: int = 0
    restart: str = "unless-stopped"
    extra_env: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_params(cls, params: dict) -> ContainerOptions:
        opts = params.get("container_options", {}) or {}
        return cls(
            image=params.get("image", opts.get("image", cls.image)),
            cpus=str(opts.get("cpus", cls.cpus)),
            memory=str(opts.get("memory", cls.memory)),
            shm_size=str(opts.get("shm_size", cls.shm_size)),
            rootfs_quota=str(opts.get("rootfs_quota", cls.rootfs_quota)),
            ssh_port=int(params.get("ssh_port", opts.get("ssh_port", 0)) or 0),
            restart=str(opts.get("restart", cls.restart)),
            extra_env=dict(opts.get("extra_env", {})),
        )


@dataclass
class Mounts:
    fast: str
    cold: str
    # Root-owned host dir holding usage.json/status.json, bind-mounted READ-ONLY at /run/labquota.
    labquota: str = ""
    seccomp_profile: str = "/etc/lab-agent/security/lab-codex-seccomp.json"
    apparmor_profile: str = "lab-codex"


def build_run_args(
    name: str,
    opts: ContainerOptions,
    mounts: Mounts,
    *,
    gpus: bool,
    storage_quota_supported: bool = True,
    labels: dict[str, str] | None = None,
) -> list[str]:
    """Pure function building the `docker run` argv (unit-tested without Docker)."""
    args = ["docker", "run", "-d", "--name", name]
    if opts.ssh_port:
        args += ["-p", f"{opts.ssh_port}:22"]
    args += ["--cpus", opts.cpus, "--memory", opts.memory, "--shm-size", opts.shm_size]
    # Standard runc + daemon-wide userns-remap provide the outer boundary. The custom profiles keep
    # outer boundary while allowing unprivileged bubblewrap to create nested namespaces.
    args += ["--runtime=runc", "--cgroupns=private", "--stop-signal", "SIGRTMIN+3"]
    args += ["--tmpfs", "/run:rw,nosuid,nodev", "--tmpfs", "/run/lock:rw,nosuid,nodev"]
    args += ["--security-opt", f"seccomp={mounts.seccomp_profile}"]
    args += ["--security-opt", f"apparmor={mounts.apparmor_profile}"]
    if gpus:
        args += ["--device", "nvidia.com/gpu=all"]
    if storage_quota_supported and opts.rootfs_quota:
        args += ["--storage-opt", f"size={opts.rootfs_quota}"]
    args += ["--restart", opts.restart]
    validate_image(opts.image)
    args += ["--mount", f"type=bind,source={mounts.fast},target=/home"]
    args += ["--mount", f"type=bind,source={mounts.cold},target=/cold-storage"]
    # labquota status dir, READ-ONLY: the agent publishes usage.json/status.json here (root-owned,
    # off any student-writable mount); students read it via the `labquota` command at /run/labquota.
    if mounts.labquota:
        args += ["--mount", f"type=bind,source={mounts.labquota},target=/run/labquota,readonly"]
    # Identity labels: mark this an agent-managed lab container (+ which lab/node). The GPU killer
    # ONLY touches processes inside a container with lab-agent.managed=true, so host processes and
    # unmanaged containers can never be warned/killed (see gpu/monitor + gpu/killer).
    for key, value in (labels or {}).items():
        args += ["--label", f"{key}={value}"]
    for key, value in sanitize_env(opts.extra_env).items():
        args += ["-e", f"{key}={value}"]
    args.append(opts.image)
    return args


def container_exists(name: str) -> bool:
    res = run(
        ["docker", "ps", "-a", "--filter", f"name=^{name}$", "--format", "{{.Names}}"], timeout=30
    )
    return res.ok and name in res.stdout.split()


def remove_container(name: str) -> None:
    if container_exists(name):
        res = run(["docker", "rm", "-f", name], timeout=120)
        if not res.ok:
            raise DockerError(res.logs)


def create_container(
    name: str,
    opts: ContainerOptions,
    mounts: Mounts,
    *,
    gpus: bool,
    labels: dict[str, str] | None = None,
) -> str:
    res = run(build_run_args(name, opts, mounts, gpus=gpus, labels=labels), timeout=180)
    if not res.ok:
        raise DockerError(res.logs)
    return res.stdout.strip()


# --------------------------------------------------------------------------- recreate primitives


def image_present(image: str) -> bool:
    """True if the image is already available locally (no registry round-trip)."""
    return run(["docker", "image", "inspect", image], timeout=60).ok


def ensure_image(image: str) -> None:
    """Make sure the image is usable before we touch the running container: validate it, and if it
    isn't present locally, try to pull it. Raises if it remains unavailable. Lab base images are
    typically built locally (no registry), so a present local image is the common success path."""
    validate_image(image)
    if image_present(image):
        return
    pulled = run(["docker", "pull", image], timeout=600)
    if not pulled.ok or not image_present(image):
        raise DockerError(f"image '{image}' unavailable locally and pull failed: {pulled.logs}")


def rename_container(old: str, new: str) -> None:
    res = run(["docker", "rename", old, new], timeout=60)
    if not res.ok:
        raise DockerError(res.logs)


def stop_container(name: str, *, timeout: float = 60.0) -> None:
    run(["docker", "stop", name], timeout=timeout + 30)


def start_container(name: str) -> None:
    res = run(["docker", "start", name], timeout=120)
    if not res.ok:
        raise DockerError(res.logs)


def wait_systemd_ready(name: str, *, timeout: float = 90.0, interval: float = 2.0) -> bool:
    """Poll until sshd is active under the container's systemd, or the timeout elapses. Verifies a
    freshly recreated container actually came up before promoting it over the preserved old one."""
    deadline = time.monotonic() + timeout
    while True:
        res = exec_in(name, ["systemctl", "is-active", "ssh"], timeout=15)
        if res.ok and res.stdout.strip() == "active":
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(interval)


def exec_in(name: str, argv: list[str], *, input_text: str | None = None,
            timeout: float = 120.0) -> CommandResult:
    return run(["docker", "exec", "-i", name, *argv], timeout=timeout, input_text=input_text)


# --------------------------------------------------------------------------- writable-layer usage
# The writable layer is a lab-level measurement only. Student homes are on the fast bind mount and
# are measured as fast usage by the per-student scan.


def writable_layer_size(name: str) -> int | None:
    """Bytes written to the container's writable layer (``SizeRw``), or None if unavailable.

    ``docker inspect --size`` returns SizeRw as an integer byte count, so no human-size parsing.
    """
    res = run(
        ["docker", "inspect", "--size", "--format", "{{.SizeRw}}", name], timeout=60
    )
    if not res.ok:
        return None
    try:
        return int(res.stdout.strip())
    except (ValueError, TypeError):
        return None


def du_path(name: str, path: str, *, timeout: float = 60.0) -> int | None:
    """Bytes used by an absolute path inside the container, or None on failure/timeout/missing path.

    ``path`` is interpolated into the argv, so callers must pass a trusted value — the only dynamic
    component used here is a username already validated against ``users.USERNAME_RE``. We use
    ``du -sB1`` (allocated blocks, in bytes) rather than ``du -sb`` (apparent size): on ZFS the
    block count is the *physical* on-disk size — after compression and ignoring sparse-file holes —
    which is exactly what the lab-level ``zfs list`` ``used`` and the per-lab quota account for. The
    apparent size double-counts holes (a 400 GiB sparse file backed by 200 GiB of blocks reads as
    400 GiB), so per-student totals could exceed the lab total; allocated blocks reconcile with it.
    We take the leading integer. A bounded timeout means a student who packs a directory with
    millions of tiny files can, at worst, make their *own* number unavailable — the scan moves on
    rather than hanging.
    """
    res = exec_in(name, ["du", "-sB1", path], timeout=timeout)
    if not res.ok:
        return None
    first = res.stdout.strip().split(None, 1)
    if not first:
        return None
    try:
        return int(first[0])
    except (ValueError, TypeError):
        return None


def du_home(name: str, username: str, *, timeout: float = 60.0) -> int | None:
    """Bytes used by a student's persistent fast home directory."""
    return du_path(name, f"/home/{username}", timeout=timeout)
