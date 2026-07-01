"""Structured host health checks for runc/userns, Codex bubblewrap, storage, and NVIDIA CDI."""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .config import AgentConfig
from .executors import docker
from .executors.base import run


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
    userns_user: str
    userns_start: int
    userns_size: int
    bwrap_ok: bool
    nested_userns_ok: bool
    codex_sandbox_ok: bool


@dataclass
class NvidiaHealth:
    gpu_count: int
    nvml_ok: bool
    loaded_driver_version: str
    userspace_driver_version: str
    cdi_ok: bool
    cdi_devices: list[str] = field(default_factory=list)


@dataclass
class StorageHealth:
    zfs_ok: bool
    fast_ok: bool
    cold_ok: bool
    cold_backend: str


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


def _zfs_root_ok(dataset: str, expected_mount: str | None = None) -> bool:
    mounted = run(["zfs", "get", "-H", "-o", "value", "mounted", dataset], timeout=15)
    mountpoint = run(["zfs", "get", "-H", "-o", "value", "mountpoint", dataset], timeout=15)
    if not mounted.ok or mounted.stdout.strip() != "yes" or not mountpoint.ok:
        return False
    path = mountpoint.stdout.strip()
    return path == expected_mount if expected_mount else path.startswith("/")


def _sysctl_int(name: str) -> int:
    res = run(["sysctl", "-n", name], timeout=10)
    try:
        return int(res.stdout.strip()) if res.ok else -1
    except ValueError:
        return -1


def _docker_userns(cfg: AgentConfig) -> bool:
    res = run(["docker", "info", "--format", "{{json .SecurityOptions}}"], timeout=20)
    if not res.ok or "userns" not in res.stdout:
        return False
    if cfg.userns_user in res.stdout:
        return _subid_ok(cfg)
    try:
        daemon = json.loads(open("/etc/docker/daemon.json", encoding="utf-8").read())
    except (OSError, json.JSONDecodeError):
        return False
    return daemon.get("userns-remap") == cfg.userns_user and _subid_ok(cfg)


def _docker_root_ok(cfg: AgentConfig) -> bool:
    # With userns-remap active, Docker nests its real root a level deeper at
    # <data-root>/<remapped-uid>.<remapped-gid> and reports that nested path here rather than the
    # configured data-root itself.
    result = run(["docker", "info", "--format", "{{.DockerRootDir}}"], timeout=20)
    if not result.ok:
        return False
    actual = os.path.realpath(result.stdout.strip())
    remapped = os.path.realpath(
        os.path.join(cfg.docker_data_root, f"{cfg.userns_start}.{cfg.userns_start}")
    )
    return actual in (os.path.realpath(cfg.docker_data_root), remapped)


def _subid_ok(cfg: AgentConfig) -> bool:
    wanted = f"{cfg.userns_user}:{cfg.userns_start}:{cfg.userns_size}"
    try:
        subuid = open("/etc/subuid", encoding="utf-8").read().splitlines()
        subgid = open("/etc/subgid", encoding="utf-8").read().splitlines()
    except OSError:
        return False
    return wanted in subuid and wanted in subgid


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


def _security_profiles_ok(cfg: AgentConfig) -> bool:
    if not os.path.isfile(cfg.seccomp_profile):
        return False
    status = run(["aa-status"], timeout=20)
    return status.ok and cfg.apparmor_profile in status.stdout


def _stale_seccomp_containers(cfg: AgentConfig) -> list[str]:
    """Return managed containers not created with the currently installed seccomp policy."""
    expected = docker.security_profile_digest(cfg.seccomp_profile)
    if not expected:
        return []
    listed = run([
        "docker", "ps", "--filter", "label=lab-agent.managed=true",
        "--format", '{{.Names}}\t{{.Label "lab-agent.seccomp-sha256"}}',
    ], timeout=20)
    if not listed.ok:
        return []
    stale: list[str] = []
    for line in listed.stdout.splitlines():
        parts = line.split("\t", 1)
        if parts and (len(parts) == 1 or parts[1] != expected):
            stale.append(parts[0])
    return stale


def _stale_systempaths_containers() -> list[str]:
    """Return managed containers created before the bubblewrap-compatible /proc contract."""
    listed = run([
        "docker", "ps", "--filter", "label=lab-agent.managed=true", "--format", "{{.Names}}",
    ], timeout=20)
    if not listed.ok:
        return []
    stale: list[str] = []
    for container in listed.stdout.splitlines():
        paths = run([
            "docker", "inspect", "--format",
            "{{json .HostConfig.MaskedPaths}}\t{{json .HostConfig.ReadonlyPaths}}", container,
        ], timeout=20)
        if not paths.ok:
            stale.append(container)
            continue
        parts = paths.stdout.strip().split("\t", 1)
        if len(parts) != 2:
            stale.append(container)
            continue
        try:
            masked_paths = json.loads(parts[0] or "[]")
            readonly_paths = json.loads(parts[1] or "[]")
        except json.JSONDecodeError:
            stale.append(container)
            continue
        if not isinstance(masked_paths, list) or not isinstance(readonly_paths, list):
            stale.append(container)
            continue
        if masked_paths or readonly_paths:
            stale.append(container)
    return stale


def _stale_lab_userns_containers() -> list[str]:
    """Return managed containers that still inherit Docker's remapped user namespace."""
    listed = run([
        "docker", "ps", "--filter", "label=lab-agent.managed=true",
        "--format", "{{.Names}}",
    ], timeout=20)
    if not listed.ok:
        return []
    stale: list[str] = []
    for container in listed.stdout.splitlines():
        mode = run([
            "docker", "inspect", "--format", "{{.HostConfig.UsernsMode}}", container,
        ], timeout=20)
        if not mode.ok or mode.stdout.strip() != "host":
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
    zfs_pools_ready = zfs_ok and _pool_exists(cfg.fast_pool) and (
        not cfg.slow_is_zfs or _pool_exists(cfg.slow_pool)
    )

    docker_ok = run(["docker", "version", "--format", "{{.Server.Version}}"], timeout=20).ok
    driver = ""
    if docker_ok:
        result = run(["docker", "info", "--format", "{{.Driver}}"], timeout=20)
        driver = result.stdout.strip() if result.ok else ""
    else:
        _issue(issues, "docker_unavailable", "critical", "Docker daemon is unreachable")
    if docker_ok and zfs_pools_ready and driver not in DOCKER_DRIVERS_OK:
        _issue(issues, "docker_storage_driver", "critical",
               f"Docker storage driver '{driver or 'unknown'}' is unsupported")
    if docker_ok and not _docker_root_ok(cfg):
        _issue(issues, "docker_data_root", "critical",
               f"Docker data-root does not match '{cfg.docker_data_root}'", True)

    userns_ok = docker_ok and _docker_userns(cfg)
    if docker_ok and not userns_ok:
        _issue(issues, "docker_userns", "critical",
               f"Docker userns-remap must use '{cfg.userns_user}'", True)

    clone_ok = _sysctl_int("kernel.unprivileged_userns_clone") == 1
    max_userns = _sysctl_int("user.max_user_namespaces")
    apparmor_restrict = _sysctl_int("kernel.apparmor_restrict_unprivileged_userns")
    nested_userns_ok = clone_ok and max_userns >= 16_384
    if not nested_userns_ok:
        _issue(issues, "bubblewrap_namespace", "critical",
               "Unprivileged user namespaces are disabled or below 16384", True)

    if apparmor_restrict == 0:
        _issue(issues, "apparmor_userns_unrestricted", "critical",
               "AppArmor unprivileged-userns restriction was globally disabled", True)

    bwrap_ok = _security_profiles_ok(cfg)
    codex_ok = False
    target: tuple[str, str] | None = None
    if deep and docker_ok:
        stale_seccomp = _stale_seccomp_containers(cfg)
        if stale_seccomp:
            _issue(
                issues,
                "container_seccomp_stale",
                "critical",
                "Managed containers require recreation after a seccomp profile update: "
                + ", ".join(stale_seccomp),
            )
        stale_systempaths = _stale_systempaths_containers()
        if stale_systempaths:
            _issue(
                issues,
                "container_systempaths_stale",
                "critical",
                "Managed containers require recreation for nested bubblewrap procfs: "
                + ", ".join(stale_systempaths),
            )
        stale_lab_userns = _stale_lab_userns_containers()
        if stale_lab_userns:
            _issue(
                issues,
                "container_userns_stale",
                "critical",
                "Managed containers require reinstall for bubblewrap-compatible user namespaces: "
                + ", ".join(stale_lab_userns),
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
            mode = run(["docker", "exec", target[0], "stat", "-c", "%a", "/usr/bin/bwrap"],
                       timeout=20)
            mode_ok = mode.ok and mode.stdout.strip() == "755"
            bwrap_smoke = [
                "bwrap", "--unshare-user", "--uid", "0", "--gid", "0",
                "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
                "--unshare-pid", "--new-session", "true",
            ]
            bwrap_ok = mode_ok and _student_command(target, bwrap_smoke)
            nested_userns_ok = nested_userns_ok and _student_command(
                target, ["unshare", "--user", "--map-root-user", "true"]
            )
            codex_ok = (
                _student_command(target, ["codex", "--version"])
                and _student_command(target, ["codex", "sandbox", "--", "true"])
                and _student_command(target, ["codex", "sandbox", "--", *bwrap_smoke])
            )
            npm_prefix_ok = _student_command(
                target, ["sh", "-c", 'test "$(npm config get prefix)" = "$HOME/.local"']
            )
            if not npm_prefix_ok:
                _issue(
                    issues,
                    "codex_update_prefix",
                    "critical",
                    "Student npm prefix is not home-owned; run lab-agent host-prepare",
                    True,
                )
        else:
            _issue(
                issues,
                "codex_smoke_unavailable",
                "critical",
                "No running lab with a provisioned student is available for the Codex smoke test",
            )
    if not bwrap_ok:
        _issue(issues, "bubblewrap_failed", "critical",
               "Distribution /usr/bin/bwrap cannot create a user/PID/proc sandbox", True)
    if not nested_userns_ok and not any(i.code == "bubblewrap_namespace" for i in issues):
        _issue(issues, "bubblewrap_namespace", "critical",
               "Nested unprivileged user namespace test failed", True)
    if deep and target is not None and not codex_ok:
        _issue(issues, "codex_sandbox_failed", "critical",
               "codex sandbox -- true failed as a provisioned student")

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

    fast_ok = (
        _pool_exists(cfg.fast_pool)
        and _zfs_root_ok(cfg.labs_fast_root, cfg.fast_mount_root)
        if zfs_ok else False
    )
    if not fast_ok:
        _issue(issues, "fast_storage_missing", "critical",
               f"Fast pool '{cfg.fast_pool}' is unavailable")
    if cfg.slow_is_zfs:
        cold_ok = (
            _pool_exists(cfg.slow_pool) and _zfs_root_ok(cfg.labs_slow_root, cfg.cold_mount_root)
            if zfs_ok else False
        )
    else:
        cold_ok = os.path.ismount(cfg.slow_path) and _smb_posix_ok(cfg)
    if not cold_ok:
        code = "cold_storage_missing" if cfg.slow_is_zfs or not os.path.ismount(cfg.slow_path) \
            else "smb_posix_ownership"
        _issue(issues, code, "critical",
               f"Cold {cfg.slow_backend} storage is unavailable or lacks POSIX numeric ownership")

    severity = {"warning": 1, "critical": 2}
    status = "healthy" if not issues else max(issues, key=lambda i: severity[i.severity]).severity
    return Capabilities(
        runtime=RuntimeHealth(docker_ok, driver, userns_ok, cfg.userns_user,
                              cfg.userns_start, cfg.userns_size, bwrap_ok,
                              nested_userns_ok, codex_ok),
        nvidia=NvidiaHealth(gpu_count, nvml_ok, loaded, userspace, cdi_ok, devices),
        storage=StorageHealth(zfs_ok, fast_ok, cold_ok, cfg.slow_backend),
        health=Health(status, issues),
    )
