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
    fast_pool_present: bool
    slow_pool_present: bool
    issues: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


def _pool_exists(pool: str) -> bool:
    return run(["zpool", "list", "-H", "-o", "name", pool], timeout=15).ok


def _docker_storage_driver() -> str:
    res = run(["docker", "info", "--format", "{{.Driver}}"], timeout=20)
    return res.stdout.strip() if res.ok else ""


def _nvidia_runtime() -> bool:
    res = run(["docker", "info", "--format", "{{.Runtimes}}"], timeout=20)
    return res.ok and "nvidia" in res.stdout


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

    fast_ok = _pool_exists(cfg.fast_pool) if zfs_ok else False
    slow_ok = _pool_exists(cfg.slow_pool) if zfs_ok else False
    if zfs_ok and not fast_ok:
        issues.append(f"fast pool '{cfg.fast_pool}' not found")
    if zfs_ok and not slow_ok:
        issues.append(f"slow pool '{cfg.slow_pool}' not found")

    return Capabilities(
        zfs=zfs_ok,
        docker=docker_ok,
        docker_zfs_driver=docker_zfs,
        nvidia_runtime=nv_runtime,
        nvidia_gpu=gpus > 0,
        gpu_count=gpus,
        fast_pool_present=fast_ok,
        slow_pool_present=slow_ok,
        issues=issues,
    )
