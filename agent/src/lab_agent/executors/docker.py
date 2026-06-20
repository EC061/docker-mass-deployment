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

from dataclasses import dataclass, field

from .base import CommandResult, run


class DockerError(RuntimeError):
    pass


def container_name(lab: str) -> str:
    return f"lab-{lab}"


@dataclass
class ContainerOptions:
    image: str = "custom-ssh"
    cpus: str = "4"
    memory: str = "8g"
    shm_size: str = "1g"
    image_quota: str = "50g"  # writable layer quota via zfs storage driver
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
    if gpus:
        args += ["--gpus", "all", "--runtime=nvidia"]
    if storage_quota_supported and opts.image_quota:
        args += ["--storage-opt", f"size={opts.image_quota}"]
    args += ["--restart", opts.restart]
    # Shared lab data.
    args += ["-v", f"{mounts.fast_shared}:/labdata/fast"]
    args += ["-v", f"{mounts.slow_shared}:/labdata/slow"]
    # Per-student parents, rshared so datasets created later propagate into the container.
    args += ["--mount",
             f"type=bind,source={mounts.fast_users},target=/labusers/fast,bind-propagation=rshared"]
    args += ["--mount",
             f"type=bind,source={mounts.slow_users},target=/labusers/slow,bind-propagation=rshared"]
    for key, value in opts.extra_env.items():
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


def exec_in(name: str, argv: list[str], *, input_text: str | None = None) -> CommandResult:
    return run(["docker", "exec", "-i", name, *argv], timeout=120, input_text=input_text)
