"""Structured health checks for Docker, CUDA, storage, and NVIDIA CDI."""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .config import AgentConfig
from .executors import docker, zfs
from .executors.base import run
from .storage import mergerfs as mfs
from .storage import service


@dataclass
class HealthIssue:
    code: str
    severity: str
    message: str
    repairable: bool = False


@dataclass
class RuntimeHealth:
    docker_ok: bool
    storage_driver: str
    userns_ok: bool
    default_security_ok: bool
    cuda_toolkit_ok: bool


@dataclass
class NvidiaHealth:
    gpu_count: int
    nvml_ok: bool
    loaded_driver_version: str
    userspace_driver_version: str
    cdi_ok: bool
    cdi_devices: list[str] = field(default_factory=list)


@dataclass
class TierHealth:
    """Per-tier storage health, generalized over any number of backing pools."""

    tier: str
    backend: str
    status: str                    # healthy | degraded | unavailable
    mount_root: str
    pools: list[dict] = field(default_factory=list)
    unavailable_pools: list[str] = field(default_factory=list)
    mergerfs_ok: bool = True       # mergerfs installed when the tier needs it
    logical_mounts_ok: bool = True # every provisioned lab has its logical mount up
    bad_mounts: list[str] = field(default_factory=list)


@dataclass
class StorageHealth:
    zfs_ok: bool
    fast_ok: bool
    cold_ok: bool
    cold_backend: str
    # Generalized multi-pool view. fast_ok/cold_ok stay as the coarse booleans every existing
    # consumer reads; the detail below is what the storage UI and doctor use.
    tiers: list[TierHealth] = field(default_factory=list)
    docker_pool: str = ""
    docker_dataset: str = ""
    docker_on_native_zfs: bool = False
    quota_invariant_ok: bool = True
    quota_violations: list[str] = field(default_factory=list)


@dataclass
class Health:
    status: str
    issues: list[HealthIssue]


@dataclass
class Capabilities:
    runtime: RuntimeHealth
    nvidia: NvidiaHealth
    storage: StorageHealth
    health: Health

    @property
    def nvidia_gpu(self) -> bool:
        return self.nvidia.gpu_count > 0 and self.nvidia.nvml_ok

    @property
    def nvidia_cdi(self) -> bool:
        return self.nvidia.cdi_ok

    @property
    def issues(self) -> list[HealthIssue]:
        return self.health.issues

    def to_dict(self) -> dict:
        return asdict(self)


DOCKER_DRIVERS_OK = ("zfs",)


def _issue(items: list[HealthIssue], code: str, severity: str, message: str,
           repairable: bool = False) -> None:
    items.append(HealthIssue(code, severity, message, repairable))


def _pool_exists(pool: str) -> bool:
    return run(["zpool", "list", "-H", "-o", "name", pool], timeout=15).ok


def _docker_userns(cfg: AgentConfig) -> bool:
    """Healthy when the daemon does NOT enable userns-remap.

    Managed labs and their bind-mounted storage use the same numeric UIDs on the host and in the
    container. ``docker info`` reports ``name=userns`` exactly when the daemon is remapping.
    """
    res = run(["docker", "info", "--format", "{{json .SecurityOptions}}"], timeout=20)
    return res.ok and "name=userns" not in res.stdout


def _docker_root_ok(cfg: AgentConfig) -> bool:
    result = run(["docker", "info", "--format", "{{.DockerRootDir}}"], timeout=20)
    if not result.ok:
        return False
    actual = os.path.realpath(result.stdout.strip())
    return actual == os.path.realpath(cfg.docker_data_root)


def _docker_default_security_available() -> bool:
    """Docker should advertise both standard Linux security integrations."""
    res = run(["docker", "info", "--format", "{{json .SecurityOptions}}"], timeout=20)
    return res.ok and "name=seccomp" in res.stdout and "name=apparmor" in res.stdout


def _cdi_devices() -> list[str]:
    res = run(["nvidia-ctk", "cdi", "list"], timeout=30)
    if not res.ok:
        return []
    return sorted({line.strip().split()[0] for line in res.stdout.splitlines()
                   if line.strip().startswith("nvidia.com/gpu=")})


def _loaded_driver_version() -> str:
    try:
        text = open("/proc/driver/nvidia/version", encoding="utf-8").read()
    except OSError:
        return ""
    match = re.search(r"Kernel Module\s+([0-9.]+)", text)
    return match.group(1) if match else ""


def _nvidia_hardware_count() -> int:
    count = 0
    for vendor in Path("/sys/bus/pci/devices").glob("*/vendor"):
        try:
            class_code = vendor.with_name("class").read_text(encoding="utf-8").strip().lower()
            if (vendor.read_text(encoding="utf-8").strip().lower() == "0x10de"
                    and class_code.startswith("0x03")):
                count += 1
        except OSError:
            continue
    return count


def _userspace_driver_version() -> str:
    res = run(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"], timeout=20)
    if res.ok and res.stdout.strip():
        return res.stdout.splitlines()[0].strip()
    res = run(["dpkg-query", "-W", "-f=${Version}\n", "libnvidia-compute-*"], timeout=20)
    if not res.ok:
        return ""
    match = re.search(r"([0-9]{3,}(?:\.[0-9]+)+)", res.stdout)
    return match.group(1) if match else ""


def _stale_bind_propagation_containers() -> list[str]:
    """Return managed containers whose persistent binds cannot see later host mounts.

    Mount propagation is fixed at creation. A container created with Docker's default ``rprivate``
    binds never sees a per-student ZFS dataset mounted after it started, so a member added to a
    running lab gets the root-owned directory underneath instead of their own storage — silently,
    with no error anywhere. Only recreation can change it.
    """
    listed = run([
        "docker", "ps", "--filter", "label=lab-agent.managed=true", "--format", "{{.Names}}",
    ], timeout=20)
    if not listed.ok:
        return []
    stale: list[str] = []
    for container in listed.stdout.splitlines():
        result = run([
            "docker", "inspect", "--format",
            "{{range .HostConfig.Mounts}}{{.Target}}={{.BindOptions.Propagation}} {{end}}",
            container,
        ], timeout=20)
        if not result.ok:
            stale.append(container)
            continue
        modes = dict(
            entry.split("=", 1) for entry in result.stdout.split() if "=" in entry
        )
        if any(modes.get(target) != "rslave" for target in ("/home", "/cold-storage")):
            stale.append(container)
    return stale


def _stale_privileged_capability_containers() -> list[str]:
    """Return managed containers carrying capabilities outside Docker's normal defaults."""
    forbidden = {"SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE"}
    listed = run([
        "docker", "ps", "--filter", "label=lab-agent.managed=true", "--format", "{{.Names}}",
    ], timeout=20)
    if not listed.ok:
        return []
    stale: list[str] = []
    for container in listed.stdout.splitlines():
        result = run([
            "docker", "inspect", "--format", "{{json .HostConfig.CapAdd}}", container,
        ], timeout=20)
        if not result.ok:
            stale.append(container)
            continue
        try:
            cap_add = json.loads(result.stdout.strip() or "null") or []
        except json.JSONDecodeError:
            stale.append(container)
            continue
        normalized = {
            str(cap).upper().removeprefix("CAP_") for cap in cap_add
        } if isinstance(cap_add, list) else set()
        if normalized & forbidden:
            stale.append(container)
    return stale


def _stale_security_override_containers() -> list[str]:
    """Return managed containers that override Docker's standard seccomp/AppArmor settings."""
    listed = run([
        "docker", "ps", "--filter", "label=lab-agent.managed=true", "--format", "{{.Names}}",
    ], timeout=20)
    if not listed.ok:
        return []
    stale: list[str] = []
    for container in listed.stdout.splitlines():
        security = run([
            "docker", "inspect", "--format",
            "{{json .HostConfig.SecurityOpt}}\t{{.AppArmorProfile}}", container,
        ], timeout=20)
        if not security.ok:
            stale.append(container)
            continue
        parts = security.stdout.strip().split("\t", 1)
        try:
            opts = json.loads(parts[0] or "null") or []
        except json.JSONDecodeError:
            opts = ["invalid"]
        profile = parts[1] if len(parts) == 2 else ""
        if opts or profile != "docker-default":
            stale.append(container)
    return stale


def _first_student_container() -> tuple[str, str] | None:
    listed = run([
        "docker", "ps", "--filter", "label=lab-agent.managed=true", "--format", "{{.Names}}"
    ], timeout=20)
    if not listed.ok:
        return None
    for container in listed.stdout.splitlines():
        users = run([
            "docker", "exec", container, "getent", "passwd"
        ], timeout=20)
        if not users.ok:
            continue
        for line in users.stdout.splitlines():
            parts = line.split(":")
            if len(parts) >= 3 and parts[2].isdigit() and 10_000 <= int(parts[2]) <= 59_999:
                return container, parts[0]
    return None


def _student_command(container_user: tuple[str, str] | None, argv: list[str]) -> bool:
    if not container_user:
        return False
    container, user = container_user
    return run([
        "docker", "exec", "-u", user,
        "-e", f"HOME=/home/{user}", "-e", f"USER={user}", "-e", f"LOGNAME={user}",
        container, *argv,
    ], timeout=90).ok


def _smb_posix_ok(cfg: AgentConfig) -> bool:
    """Probe numeric ownership and writes without ever creating an unmounted fallback tree."""
    if not os.path.ismount(cfg.slow_path):
        return False
    probe = os.path.join(cfg.slow_path, f".lab-agent-posix-probe-{os.getpid()}")
    mapped = 10_000
    child = os.path.join(probe, "write-test")
    try:
        os.mkdir(probe, 0o700)
        os.chown(probe, mapped, mapped)
        if (os.lstat(probe).st_uid, os.lstat(probe).st_gid) != (mapped, mapped):
            return False
        result = run([
            "setpriv", "--reuid", str(mapped), "--regid", str(mapped), "--clear-groups",
            "touch", child,
        ], timeout=20)
        return result.ok and os.lstat(child).st_uid == mapped
    except OSError:
        return False
    finally:
        try:
            if os.path.lexists(child):
                os.unlink(child)
            if os.path.isdir(probe):
                os.rmdir(probe)
        except OSError:
            pass


def detect_capabilities(cfg: AgentConfig, *, deep: bool = True) -> Capabilities:
    issues: list[HealthIssue] = []
    zfs_ok = run(["zfs", "version"], timeout=15).ok
    if not zfs_ok:
        _issue(issues, "zfs_missing", "critical", "ZFS is unavailable")

    # host-prepare only puts Docker's data-root on a ZFS dataset once the pool(s) it needs exist
    # (see hostprep._zfs_pools_ready); before that, a plain install on the default backing store is
    # expected and the missing pool(s) are already flagged below via fast/cold_storage_missing.
    docker_pool_ready = zfs_ok and _pool_exists(cfg.storage.docker.pool)

    docker_ok = run(["docker", "version", "--format", "{{.Server.Version}}"], timeout=20).ok
    driver = ""
    if docker_ok:
        result = run(["docker", "info", "--format", "{{.Driver}}"], timeout=20)
        driver = result.stdout.strip() if result.ok else ""
    else:
        _issue(issues, "docker_unavailable", "critical", "Docker daemon is unreachable")
    if docker_ok and docker_pool_ready and driver not in DOCKER_DRIVERS_OK:
        _issue(issues, "docker_storage_driver", "critical",
               f"Docker storage driver '{driver or 'unknown'}' is unsupported")
    if docker_ok and not _docker_root_ok(cfg):
        _issue(issues, "docker_data_root", "critical",
               f"Docker data-root does not match '{cfg.docker_data_root}'", True)

    userns_ok = docker_ok and _docker_userns(cfg)
    if docker_ok and not userns_ok:
        _issue(issues, "docker_userns", "critical",
               "Docker userns-remap must be disabled so bind-mounted storage keeps identity "
               "numeric UIDs; re-run host-prepare and recreate placements")

    default_security_ok = docker_ok and _docker_default_security_available()
    if docker_ok and not default_security_ok:
        _issue(issues, "docker_default_security", "critical",
               "Docker must provide its standard seccomp and AppArmor integrations")

    cuda_ok = False
    target: tuple[str, str] | None = None
    if deep and docker_ok:
        stale_caps = _stale_privileged_capability_containers()
        if stale_caps:
            _issue(
                issues,
                "container_capabilities_stale",
                "critical",
                "Managed containers carry non-standard privileged capabilities and require "
                "recreation: " + ", ".join(stale_caps),
            )
        stale_propagation = _stale_bind_propagation_containers()
        if stale_propagation:
            _issue(
                issues,
                "container_bind_propagation_stale",
                "warning",
                "Managed containers cannot see per-student datasets mounted after they started "
                "and require recreation: " + ", ".join(stale_propagation),
            )
        stale_security = _stale_security_override_containers()
        if stale_security:
            _issue(
                issues,
                "container_security_overrides_stale",
                "critical",
                "Managed containers override Docker's standard seccomp/AppArmor settings and "
                "require recreation: " + ", ".join(stale_security),
            )
        target = _first_student_container()
        if target:
            if not docker.wait_ssh_ready(target[0], timeout=10, interval=1):
                _issue(
                    issues,
                    "ssh_handshake_failed",
                    "critical",
                    f"SSH key exchange failed in '{target[0]}'; inspect its Docker logs",
                )
            cuda_ok = _student_command(target, ["nvcc", "--version"])
        else:
            _issue(
                issues,
                "lab_smoke_unavailable",
                "critical",
                "No running lab with a provisioned student is available for the CUDA check",
            )
    if deep and target is not None and not cuda_ok:
        _issue(issues, "cuda_toolkit_failed", "critical",
               "nvcc --version failed as a provisioned student")

    gpu_list = run(["nvidia-smi", "-L"], timeout=20)
    smi_count = sum(1 for line in gpu_list.stdout.splitlines()
                    if line.strip().startswith("GPU")) if gpu_list.ok else 0
    gpu_count = max(smi_count, _nvidia_hardware_count())
    loaded = _loaded_driver_version()
    userspace = _userspace_driver_version()
    nvml_ok = gpu_list.ok
    if loaded and (not nvml_ok or (userspace and loaded != userspace)):
        _issue(issues, "nvml_driver_mismatch", "critical",
               "NVIDIA kernel/userspace driver mismatch; reboot the node", False)
    elif gpu_count and not nvml_ok:
        _issue(
            issues,
            "nvidia_kernel_failure",
            "critical",
            "NVIDIA hardware is present but NVML failed; inspect DKMS, Secure Boot, "
            "Fabric Manager, and kernel logs",
            False,
        )
    if gpu_count and run(["systemctl", "is-failed", "nvidia-fabricmanager.service"],
                         timeout=15).ok:
        _issue(issues, "nvidia_fabric_manager", "critical",
               "NVIDIA Fabric Manager is failed and requires operator repair", False)
    devices = _cdi_devices()
    cdi_names = {device.partition("=")[2] for device in devices}
    identifiers = set(re.findall(r"\(UUID:\s*([^)]+)\)", gpu_list.stdout))
    expected = {"all", *(str(index) for index in range(smi_count)), *identifiers}
    cdi_ok = gpu_count == 0 or (nvml_ok and expected <= cdi_names)
    if gpu_count and not cdi_ok:
        _issue(issues, "nvidia_cdi_stale", "critical",
               "NVIDIA CDI devices are missing or stale", True)

    tiers = _tier_healths(cfg, issues, zfs_ok=zfs_ok, deep=deep)
    fast_ok = next(t.status == "healthy" for t in tiers if t.tier == "fast")
    cold_tier = next(t for t in tiers if t.tier == "cold")
    if cfg.slow_is_zfs:
        cold_ok = cold_tier.status == "healthy"
    else:
        cold_ok = os.path.ismount(cfg.slow_path) and _smb_posix_ok(cfg)
        if not cold_ok:
            code = "cold_storage_missing" if not os.path.ismount(cfg.slow_path) \
                else "smb_posix_ownership"
            _issue(issues, code, "critical",
                   "Cold smb storage is unavailable or lacks POSIX numeric ownership")

    docker_on_zfs, quota_ok, quota_violations = _docker_and_quota_health(cfg, issues, zfs_ok, deep)

    severity = {"warning": 1, "critical": 2}
    status = "healthy" if not issues else max(issues, key=lambda i: severity[i.severity]).severity
    return Capabilities(
        runtime=RuntimeHealth(docker_ok, driver, userns_ok, default_security_ok, cuda_ok),
        nvidia=NvidiaHealth(gpu_count, nvml_ok, loaded, userspace, cdi_ok, devices),
        storage=StorageHealth(
            zfs_ok, fast_ok, cold_ok, cfg.slow_backend, tiers=tiers,
            docker_pool=cfg.storage.docker.pool, docker_dataset=cfg.docker_dataset,
            docker_on_native_zfs=docker_on_zfs, quota_invariant_ok=quota_ok,
            quota_violations=quota_violations,
        ),
        health=Health(status, issues),
    )


def _tier_healths(
    cfg: AgentConfig, issues: list[HealthIssue], *, zfs_ok: bool, deep: bool
) -> list[TierHealth]:
    """Per-tier storage validation, for any number of pools.

    Checks, per tier: every configured pool is imported and ONLINE; each pool's container dataset
    (``<pool>/labs``) is a REAL mounted ZFS filesystem at the expected path (never a leftover
    directory); mergerfs is installed when the tier needs it; and every provisioned lab's logical
    mount (``/fast/<lab>``, ``/cold-storage/<lab>``) is up with the branches it should have.
    """
    out: list[TierHealth] = []
    for tier in cfg.storage.tiers():
        if not tier.is_zfs_owned:
            status, _healths = service.tier_health(tier)
            out.append(TierHealth(tier.name, tier.backend, status, tier.cold_root))
            continue
        if not zfs_ok:
            out.append(TierHealth(tier.name, tier.backend, "unavailable", tier.mount_root,
                                  unavailable_pools=list(tier.pools)))
            _issue(issues, f"{tier.name}_storage_missing", "critical",
                   f"ZFS is unavailable, so the {tier.name} tier cannot be validated")
            continue
        status, healths = service.tier_health(tier)
        bad = [h.pool for h in healths if not h.usable]
        merger_ok = (not tier.uses_mergerfs) or mfs.available()
        entry = TierHealth(
            tier=tier.name, backend=tier.backend, status=status, mount_root=tier.mount_root,
            pools=[h.to_dict() for h in healths], unavailable_pools=bad, mergerfs_ok=merger_ok,
        )
        if status == "unavailable":
            _issue(issues, f"{tier.name}_storage_missing", "critical",
                   f"No pool of the {tier.name} tier is available "
                   f"({', '.join(tier.pools)}); labs on this tier cannot be provisioned")
        elif status == "degraded":
            _issue(issues, f"{tier.name}_storage_degraded", "critical",
                   f"{tier.name} tier is DEGRADED: pool(s) {', '.join(bad)} are missing or not "
                   "mounted where expected. Surviving branches stay readable; quota expansion and "
                   "destructive operations are blocked until the pool returns or is removed.")
        if not merger_ok:
            _issue(issues, f"{tier.name}_mergerfs_missing", "critical",
                   f"The {tier.name} tier uses the mergerfs backend but mergerfs is not installed; "
                   "run `lab-agent host-prepare`", True)
        if deep and merger_ok and status != "unavailable":
            entry.bad_mounts = _bad_logical_mounts(tier)
            entry.logical_mounts_ok = not entry.bad_mounts
            if entry.bad_mounts:
                _issue(issues, f"{tier.name}_logical_mount_missing", "critical",
                       f"{tier.name} logical mount(s) are down: {', '.join(entry.bad_mounts)}. "
                       "Run `lab-agent storage mount` (or restart lab-storage-mounts.service).")
        out.append(entry)
    return out


def _bad_logical_mounts(tier) -> list[str]:
    """Provisioned labs whose container-facing path is not the mount it should be."""
    bad: list[str] = []
    for lab in service.discover_labs(tier):
        target = tier.logical_mount(lab)
        if tier.uses_mergerfs:
            if not mfs.is_mergerfs_mount(target):
                bad.append(target)
                continue
            live = set(mfs.current_branches(target))
            expected = {b.path for b in service.observe_branches(tier, lab) if b.present}
            if live != expected:
                details = []
                if expected - live:
                    details.append("missing: " + ", ".join(sorted(expected - live)))
                if live - expected:
                    details.append("unexpected: " + ", ".join(sorted(live - expected)))
                bad.append(f"{target} ({'; '.join(details)})")
        else:
            state = zfs.mount_state(tier.branch_dataset(tier.pools[0], lab), target)
            if not state.ok or not os.path.ismount(target):
                bad.append(target)
    return bad


def _docker_and_quota_health(
    cfg: AgentConfig, issues: list[HealthIssue], zfs_ok: bool, deep: bool
) -> tuple[bool, bool, list[str]]:
    """Docker must stay on NATIVE ZFS, and branch quotas must obey the per-lab invariant."""
    docker_on_zfs = False
    if zfs_ok:
        docker_on_zfs = zfs.dataset_exists(cfg.docker_dataset)
        if docker_on_zfs:
            state = zfs.mount_state(cfg.docker_dataset, cfg.docker_data_root)
            if not state.ok:
                _issue(issues, "docker_dataset_mount", "critical",
                       f"Docker dataset {cfg.docker_dataset} is not mounted at "
                       f"{cfg.docker_data_root}")
            for tier in cfg.storage.tiers():
                if tier.uses_mergerfs and cfg.docker_data_root.startswith(
                    tier.mount_root.rstrip("/") + "/"
                ):
                    _issue(issues, "docker_on_mergerfs", "critical",
                           "Docker's data-root is inside a mergerfs tier; the zfs storage driver "
                           "requires a native ZFS dataset")
    violations: list[str] = []
    if deep and zfs_ok:
        violations = _quota_violations(cfg)
        if violations:
            _issue(issues, "storage_quota_invariant", "critical",
                   "Branch quotas exceed the configured lab quota for: " + "; ".join(violations))
    return docker_on_zfs, not violations, violations


def _quota_violations(cfg: AgentConfig) -> list[str]:
    """Labs whose branch quotas sum above their configured logical tier quota (INV-1)."""
    from .storage.state import StorageState

    state = StorageState.load(cfg.storage_state_path)
    out: list[str] = []
    for tier in cfg.storage.tiers():
        if not tier.is_zfs_owned:
            continue
        for lab in service.discover_labs(tier):
            record = state.lab_or_none(tier.name, lab)
            configured = record.configured_quota_bytes if record else None
            if configured is None:
                continue
            branches = service.observe_branches(tier, lab)
            if any(b.present and b.quota is None for b in branches):
                out.append(f"{tier.name}/{lab} has an UNLIMITED branch dataset")
                continue
            committed = sum(b.quota or 0 for b in branches if b.present)
            committed += sum(
                max(b.quota_bytes or 0, b.used_bytes or 0)
                for b in (record.branches.values() if record else [])
                if b.state == "missing"
            )
            if committed > configured:
                out.append(f"{tier.name}/{lab} committed {committed} > configured {configured}")
    return out
