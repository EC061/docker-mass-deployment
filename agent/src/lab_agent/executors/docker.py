"""Docker executor for lab containers.

One shared container per lab (name ``lab-<lab>``). Creation-time options (cpu/ram/shm/image-quota/
port/restart) are baked into ``docker run`` and frozen for the container's life; changing them means
``recreate`` (which preserves the ZFS data, since data lives in bind-mounted datasets, not the
container layer). All NVIDIA GPUs are always passed.

The container mounts, fixed at creation:
    <fast>/labs/<lab>/shared -> /labdata/fast
    <slow>/labs/<lab>/shared -> /labdata/slow
    <fast>/labs/<lab>/users  -> /labusers/fast   (rshared: new per-student datasets appear live)
    <slow>/labs/<lab>/users  -> /labusers/slow   (rshared)
"""

from __future__ import annotations

import re
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
    image: str = "custom-ssh"
    cpus: str = "4"
    memory: str = "8g"
    shm_size: str = "1g"
    image_quota: str = "300g"  # writable layer quota via zfs storage driver
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
            image_quota=str(opts.get("image_quota", cls.image_quota)),
            ssh_port=int(params.get("ssh_port", opts.get("ssh_port", 0)) or 0),
            restart=str(opts.get("restart", cls.restart)),
            extra_env=dict(opts.get("extra_env", {})),
        )


@dataclass
class Mounts:
    fast_shared: str
    slow_shared: str
    fast_users: str
    slow_users: str


def build_run_args(
    name: str,
    opts: ContainerOptions,
    mounts: Mounts,
    *,
    gpus: bool,
    storage_quota_supported: bool = True,
) -> list[str]:
    """Pure function building the `docker run` argv (unit-tested without Docker)."""
    args = ["docker", "run", "-d", "--name", name]
    if opts.ssh_port:
        args += ["-p", f"{opts.ssh_port}:22"]
    args += ["--cpus", opts.cpus, "--memory", opts.memory, "--shm-size", opts.shm_size]
    # Every lab container runs under Sysbox: nested Docker without --privileged, plus a mandatory
    # user-namespace remap so container-root (even via a user's sudo) maps to an unprivileged host
    # UID and cannot reach host root. GPUs are injected via the NVIDIA Container Device Interface
    # (CDI), which docker applies independently of the OCI runtime, so it composes with sysbox-runc.
    # (--runtime=nvidia cannot be combined with sysbox-runc, and is no longer needed.)
    args += ["--runtime=sysbox-runc"]
    if gpus:
        args += ["--device", "nvidia.com/gpu=all"]
    if storage_quota_supported and opts.image_quota:
        args += ["--storage-opt", f"size={opts.image_quota}"]
    args += ["--restart", opts.restart]
    validate_image(opts.image)
    # Shared lab data.
    args += ["-v", f"{mounts.fast_shared}:/labdata/fast"]
    args += ["-v", f"{mounts.slow_shared}:/labdata/slow"]
    # Per-student parents, rshared so datasets created later propagate into the container.
    args += ["--mount",
             f"type=bind,source={mounts.fast_users},target=/labusers/fast,bind-propagation=rshared"]
    args += ["--mount",
             f"type=bind,source={mounts.slow_users},target=/labusers/slow,bind-propagation=rshared"]
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


def create_container(name: str, opts: ContainerOptions, mounts: Mounts, *, gpus: bool) -> str:
    res = run(build_run_args(name, opts, mounts, gpus=gpus), timeout=180)
    if not res.ok:
        raise DockerError(res.logs)
    return res.stdout.strip()


def exec_in(name: str, argv: list[str], *, input_text: str | None = None,
            timeout: float = 120.0) -> CommandResult:
    return run(["docker", "exec", "-i", name, *argv], timeout=timeout, input_text=input_text)


# --------------------------------------------------------------------------- writable-layer usage
# Per-student storage in scratch/cold-storage is ZFS and measured cheaply via dataset metadata.
# Anything a student installs into their container home (pip/conda envs, software) lives in the
# container's writable layer instead, which ZFS quota does not break down per student. These helpers
# measure that layer (total + per-home `du`) for the labquota usage report.


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
    component used here is a username already validated against ``users.USERNAME_RE``. ``du -sb``
    reports apparent size in bytes; we take the leading integer. A bounded timeout means a student
    who packs a directory with millions of tiny files can, at worst, make their *own* number
    unavailable — the scan moves on rather than hanging.
    """
    res = exec_in(name, ["du", "-sb", path], timeout=timeout)
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
    """Bytes used by a student's home directory (installed software) inside the container.

    Counts ``/home/<u>`` only; the student's scratch/cold-storage live there as symlinks, which
    ``du`` does not follow, so the fast/cold tiers are measured separately (see ``du_path``).
    """
    return du_path(name, f"/home/{username}", timeout=timeout)
