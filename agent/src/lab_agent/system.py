"""Host capability checks: zfs, docker, nvidia, and the expected ZFS pools.

Used by `lab-agent doctor` and reported to the controller in the hello frame so the UI can show
what each node can do. Adapts the NVIDIA detection from the old core/utils/arg_validator.py.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .config import AgentConfig
from .executors.base import run


@dataclass
class Capabilities:
    zfs: bool
    docker: bool
    docker_zfs_driver: bool
    nvidia_runtime: bool
    nvidia_gpu: bool
    gpu_count: int
    sysbox: bool  # the sysbox-runc OCI runtime is registered (required for nested Docker)
    nvidia_cdi: bool  # an NVIDIA CDI spec exists (how GPUs are attached under sysbox-runc)
    fast_pool_present: bool
    slow_pool_present: bool
    slow_backend: str  # "zfs" or "smb"
    slow_shared: bool  # cold storage shared between nodes (smb only)
    issues: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


def _pool_exists(pool: str) -> bool:
    return run(["zpool", "list", "-H", "-o", "name", pool], timeout=15).ok


def _is_mountpoint(path: str) -> bool:
    import os

    return os.path.ismount(path)


def _docker_storage_driver() -> str:
    res = run(["docker", "info", "--format", "{{.Driver}}"], timeout=20)
    return res.stdout.strip() if res.ok else ""


def _nvidia_runtime() -> bool:
    res = run(["docker", "info", "--format", "{{.Runtimes}}"], timeout=20)
    return res.ok and "nvidia" in res.stdout


def _sysbox_runtime() -> bool:
    """The Sysbox OCI runtime is registered (lab containers run with --runtime=sysbox-runc)."""
    res = run(["docker", "info", "--format", "{{.Runtimes}}"], timeout=20)
    return res.ok and "sysbox-runc" in res.stdout


def _cdi_present() -> bool:
    """An NVIDIA CDI spec exists. GPUs are injected with `--device nvidia.com/gpu=all` (runtime-
    agnostic, so it composes with sysbox-runc), generated via `nvidia-ctk cdi generate`."""
    import os

    return os.path.exists("/etc/cdi/nvidia.yaml") or os.path.exists("/var/run/cdi/nvidia.yaml")


def _gpu_count() -> int:
    res = run(["nvidia-smi", "-L"], timeout=20)
    if not res.ok:
        return 0
    return sum(1 for line in res.stdout.splitlines() if line.strip().startswith("GPU"))


def detect_capabilities(cfg: AgentConfig) -> Capabilities:
    issues: list[str] = []

    zfs_ok = run(["zfs", "version"], timeout=15).ok
    if not zfs_ok:
        issues.append("zfs command not found")

    docker_ok = run(["docker", "version", "--format", "{{.Server.Version}}"], timeout=20).ok
    if not docker_ok:
        issues.append("docker not reachable")

    driver = _docker_storage_driver() if docker_ok else ""
    docker_zfs = driver == "zfs"
    if docker_ok and not docker_zfs:
        issues.append(f"docker storage driver is '{driver}', expected 'zfs' (see host-prep docs)")

    nv_runtime = _nvidia_runtime() if docker_ok else False
    gpus = _gpu_count()

    # Lab containers run under Sysbox for host-isolated nested Docker; flag a node that lacks it.
    sysbox = _sysbox_runtime() if docker_ok else False
    if docker_ok and not sysbox:
        issues.append(
            "sysbox-runc runtime not found: nested Docker needs Sysbox CE (see host-prep docs)"
        )
    # GPUs are attached via CDI (not the nvidia runtime, which can't combine with sysbox-runc).
    cdi = _cdi_present()
    if gpus > 0 and not cdi:
        issues.append(
            "NVIDIA GPUs present but no CDI spec found; run `nvidia-ctk cdi generate "
            "--output=/etc/cdi/nvidia.yaml` or GPUs will not be attached to lab containers"
        )

    fast_ok = _pool_exists(cfg.fast_pool) if zfs_ok else False
    if zfs_ok and not fast_ok:
        issues.append(f"fast pool '{cfg.fast_pool}' not found")

    # Cold storage: a local ZFS pool, or an externally-managed SMB/CIFS mount.
    if cfg.slow_is_zfs:
        slow_ok = _pool_exists(cfg.slow_pool) if zfs_ok else False
        if zfs_ok and not slow_ok:
            issues.append(f"slow pool '{cfg.slow_pool}' not found")
    else:
        slow_ok = _is_mountpoint(cfg.slow_path)
        if not slow_ok:
            issues.append(f"cold-storage SMB mount '{cfg.slow_path}' is not mounted")

    return Capabilities(
        zfs=zfs_ok,
        docker=docker_ok,
        docker_zfs_driver=docker_zfs,
        nvidia_runtime=nv_runtime,
        nvidia_gpu=gpus > 0,
        gpu_count=gpus,
        sysbox=sysbox,
        nvidia_cdi=cdi,
        fast_pool_present=fast_ok,
        slow_pool_present=slow_ok,
        slow_backend=cfg.slow_backend,
        slow_shared=cfg.slow_shared,
        issues=issues,
    )
