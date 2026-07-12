"""Idempotent host preparation for Docker, storage, and bubblewrap security profiles.

Besides converging config, this installs everything host-prepare itself depends on: Docker Engine
(from Docker's official apt repo), ZFS userspace tools, AppArmor tooling, and — only when NVIDIA
GPU hardware is present — the NVIDIA Container Toolkit. It never installs the NVIDIA kernel driver
itself (needs a reboot and hardware-specific version choice) or creates zpools (disk topology is
the operator's call); both remain documented manual prerequisites.
"""

from __future__ import annotations

import grp
import json
import os
import pwd
import shutil
from collections.abc import Sequence
from importlib import resources
from pathlib import Path
from typing import Any

from .config import AgentConfig
from .executors.base import run
from .system import _nvidia_hardware_count, _pool_exists

DAEMON_JSON = Path("/etc/docker/daemon.json")
SUBUID = Path("/etc/subuid")
SUBGID = Path("/etc/subgid")
SYSCTL_FILE = Path("/etc/sysctl.d/90-lab-codex.conf")
APPARMOR_DEST = Path("/etc/apparmor.d/lab-codex")

# Packages available from the default Ubuntu archive. ca-certificates/curl/gnupg are fetched first
# because adding the Docker/NVIDIA apt repos below needs them.
PREREQ_APT_PACKAGES = ("ca-certificates", "curl", "gnupg")
CORE_APT_PACKAGES = ("zfsutils-linux", "apparmor", "apparmor-utils")
DOCKER_APT_PACKAGES = (
    "docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin",
)
NVIDIA_APT_PACKAGES = ("nvidia-container-toolkit",)

DOCKER_GPG_KEY = Path("/etc/apt/keyrings/docker.asc")
DOCKER_APT_LIST = Path("/etc/apt/sources.list.d/docker.list")
NVIDIA_GPG_KEY = Path("/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg")
NVIDIA_APT_LIST = Path("/etc/apt/sources.list.d/nvidia-container-toolkit.list")
NVIDIA_GPG_KEY_URL = "https://nvidia.github.io/libnvidia-container/gpgkey"
NVIDIA_APT_LIST_URL = (
    "https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list"
)


def mapped_host_id(cfg: AgentConfig, container_id: int) -> int:
    if not 0 <= container_id < cfg.userns_size:
        raise ValueError(f"container id {container_id} is outside the subordinate-id range")
    return cfg.userns_start + container_id


# Certain runc versions drop a container's access to its GPU device nodes on `systemctl
# daemon-reload` when using the systemd cgroup driver and the NVIDIA driver hasn't created the
# /dev/char symlinks those runc versions need to re-apply the device cgroup rule (see
# https://github.com/opencontainers/runc/discussions/1133). Docker's own cgroupfs driver isn't
# affected, so GPU nodes get pinned to it.
NVIDIA_CGROUPFS_EXEC_OPT = "native.cgroupdriver=cgroupfs"


def merge_daemon_config(current: dict[str, Any], cfg: AgentConfig, *, use_zfs: bool,
                         gpu_present: bool) -> dict[str, Any]:
    merged = dict(current)
    # Deliberately NOT enabling "userns-remap". Labs run with --userns=host (bubblewrap needs the
    # initial user namespace, see executors/docker.py), which opts each container out of remapping
    # anyway — so a daemon-wide remap gives labs no containment. Its only real effect is that Docker
    # unpacks the image into a remapped graph store and chowns every file, including setuid
    # /usr/bin/passwd and /usr/bin/sudo, to the subordinate base UID; under --userns=host those
    # binaries then elevate to that unprivileged UID instead of real root, so passwd, sudo, and
    # every other setuid-root program fail inside the lab ("Authentication token manipulation
    # error"). Drop any stale key an earlier agent left behind.
    merged.pop("userns-remap", None)
    merged["data-root"] = cfg.docker_data_root
    if use_zfs:
        # The data-root is a native ZFS dataset; the zfs graphdriver clones it per layer/container
        # and honours --storage-opt size via ZFS's own "quota" property.
        merged["storage-driver"] = "zfs"
    if gpu_present:
        # Replace rather than append: Docker rejects daemon.json if "native.cgroupdriver" appears
        # in exec-opts more than once, so any prior value (ours from an earlier run, or an
        # operator's) is dropped in favour of the workaround.
        exec_opts = [o for o in merged.get("exec-opts", [])
                     if not o.startswith("native.cgroupdriver=")]
        exec_opts.append(NVIDIA_CGROUPFS_EXEC_OPT)
        merged["exec-opts"] = exec_opts
    return merged


def docker_quota_zfs_value(quota_gb: int) -> str:
    """ZFS "quota" property value for a GiB cap, or "none" for unlimited (mirrors the "0" = no
    quota convention Docker's own zfs storage driver uses for --storage-opt size)."""
    return f"{int(quota_gb)}G" if quota_gb else "none"


def docker_apt_source_line(arch: str, codename: str) -> str:
    return (
        f"deb [arch={arch} signed-by={DOCKER_GPG_KEY}] "
        f"https://download.docker.com/linux/ubuntu {codename} stable\n"
    )


def rewrite_nvidia_apt_list(raw: str) -> str:
    """Inject signed-by=<our keyring> into NVIDIA's published sources.list content."""
    return raw.replace("deb https://", f"deb [signed-by={NVIDIA_GPG_KEY}] https://")


def replace_subid_entry(text: str, user: str, start: int, size: int) -> str:
    lines = [line for line in text.splitlines() if line and not line.startswith(f"{user}:")]
    lines.append(f"{user}:{start}:{size}")
    return "\n".join(lines) + "\n"


def subid_conflicts(text: str, user: str, start: int, size: int) -> bool:
    end = start + size
    for line in text.splitlines():
        parts = line.split(":")
        if len(parts) != 3 or parts[0] == user:
            continue
        try:
            other_start, other_size = int(parts[1]), int(parts[2])
        except ValueError:
            continue
        if start < other_start + other_size and other_start < end:
            return True
    return False


def _write(path: Path, text: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.chmod(mode)
    os.replace(tmp, path)


def _require_root() -> None:
    if os.geteuid() != 0:
        raise PermissionError("host-prepare must run as root")


def _dpkg_installed(pkg: str) -> bool:
    result = run(["dpkg-query", "-W", "-f=${Status}", pkg], timeout=15)
    return result.ok and "install ok installed" in result.stdout


def _missing_packages(names: Sequence[str]) -> list[str]:
    return [name for name in names if not _dpkg_installed(name)]


def _apt_update() -> None:
    result = run(["apt-get", "update"], timeout=180)
    if not result.ok:
        raise RuntimeError(f"apt-get update failed: {result.logs}")


def _apt_install(packages: Sequence[str]) -> None:
    missing = _missing_packages(packages)
    if not missing:
        return
    result = run(
        ["apt-get", "install", "-y",
         "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
         *missing],
        timeout=600,
    )
    if not result.ok:
        raise RuntimeError(f"apt-get install failed for {', '.join(missing)}: {result.logs}")


def _os_codename() -> str:
    try:
        text = Path("/etc/os-release").read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"cannot read /etc/os-release: {exc}") from exc
    for line in text.splitlines():
        if line.startswith("VERSION_CODENAME="):
            return line.split("=", 1)[1].strip().strip('"')
    raise RuntimeError("VERSION_CODENAME not found in /etc/os-release")


def _dpkg_arch() -> str:
    result = run(["dpkg", "--print-architecture"], timeout=10)
    if not result.ok:
        raise RuntimeError(f"could not determine dpkg architecture: {result.logs}")
    return result.stdout.strip()


def _ensure_docker_apt_repo() -> bool:
    """Add Docker's official apt repo + signing key if missing. Returns True if newly added."""
    if DOCKER_GPG_KEY.exists() and DOCKER_APT_LIST.exists():
        return False
    key = run(["curl", "-fsSL", "https://download.docker.com/linux/ubuntu/gpg"], timeout=30)
    if not key.ok or not key.stdout.strip():
        raise RuntimeError(f"could not fetch the Docker apt signing key: {key.logs}")
    _write(DOCKER_GPG_KEY, key.stdout, mode=0o644)
    _write(DOCKER_APT_LIST, docker_apt_source_line(_dpkg_arch(), _os_codename()))
    return True


def _ensure_nvidia_apt_repo() -> bool:
    """Add the NVIDIA Container Toolkit apt repo + signing key if missing. Returns True if newly
    added."""
    if NVIDIA_GPG_KEY.exists() and NVIDIA_APT_LIST.exists():
        return False
    key = run(["curl", "-fsSL", NVIDIA_GPG_KEY_URL], timeout=30)
    if not key.ok or not key.stdout.strip():
        raise RuntimeError(f"could not fetch the NVIDIA apt signing key: {key.logs}")
    NVIDIA_GPG_KEY.parent.mkdir(parents=True, exist_ok=True)
    dearmored = run(["gpg", "--yes", "--dearmor", "-o", str(NVIDIA_GPG_KEY)],
                     timeout=15, input_text=key.stdout)
    if not dearmored.ok:
        raise RuntimeError(f"could not dearmor the NVIDIA apt signing key: {dearmored.logs}")
    listing = run(["curl", "-fsSL", NVIDIA_APT_LIST_URL], timeout=30)
    if not listing.ok or not listing.stdout.strip():
        raise RuntimeError(f"could not fetch the NVIDIA apt repo list: {listing.logs}")
    _write(NVIDIA_APT_LIST, rewrite_nvidia_apt_list(listing.stdout))
    return True


def _ensure_base_packages() -> bool:
    """Install Docker Engine, ZFS tools, and AppArmor tooling. Returns True if Docker Engine was
    newly installed by this call (as opposed to already present from an earlier run or a prior,
    unmanaged install)."""
    os.environ.setdefault("DEBIAN_FRONTEND", "noninteractive")
    if _missing_packages(PREREQ_APT_PACKAGES):
        _apt_update()
        _apt_install(PREREQ_APT_PACKAGES)

    repo_added = _ensure_docker_apt_repo()
    docker_missing = _missing_packages(DOCKER_APT_PACKAGES)
    if repo_added or docker_missing or _missing_packages(CORE_APT_PACKAGES):
        _apt_update()
    _apt_install(CORE_APT_PACKAGES)
    _apt_install(DOCKER_APT_PACKAGES)
    return bool(docker_missing)


def _ensure_nvidia_toolkit_if_present(gpu_present: bool) -> None:
    """Install nvidia-container-toolkit when NVIDIA GPU hardware is present. Never touches the
    proprietary driver itself; that stays a manual, reboot-requiring operator step."""
    if not gpu_present or not _missing_packages(NVIDIA_APT_PACKAGES):
        return
    if _ensure_nvidia_apt_repo():
        _apt_update()
    _apt_install(NVIDIA_APT_PACKAGES)


def _ensure_account(user: str) -> None:
    try:
        grp.getgrnam(user)
    except KeyError:
        result = run(["groupadd", "--system", user])
        if not result.ok:
            raise RuntimeError(result.logs) from None
    try:
        pwd.getpwnam(user)
    except KeyError:
        result = run([
            "useradd", "--system", "--gid", user, "--home-dir", "/nonexistent",
            "--shell", "/usr/sbin/nologin", user,
        ])
        if not result.ok:
            raise RuntimeError(result.logs) from None


def _install_security_assets(cfg: AgentConfig) -> None:
    asset_root = resources.files("lab_agent").joinpath("assets")
    seccomp = asset_root.joinpath("lab-codex-seccomp.json").read_text(encoding="utf-8")
    apparmor = asset_root.joinpath("lab-codex.apparmor").read_text(encoding="utf-8")
    if not Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").exists():
        # AppArmor 3-era Ubuntu kernels do not mediate userns and reject the AppArmor 4 rule.
        apparmor = apparmor.replace("    userns,\n", "")
    _write(Path(cfg.seccomp_profile), seccomp)
    _write(APPARMOR_DEST, apparmor)
    loaded = run(["apparmor_parser", "-r", str(APPARMOR_DEST)], timeout=30)
    if not loaded.ok:
        raise RuntimeError(f"could not load lab-codex AppArmor profile: {loaded.logs}")

    distro_bwrap = Path("/usr/share/apparmor/extra-profiles/bwrap-userns-restrict")
    if distro_bwrap.exists():
        target = Path("/etc/apparmor.d/bwrap-userns-restrict")
        shutil.copyfile(distro_bwrap, target)
        target.chmod(0o644)
        loaded = run(["apparmor_parser", "-r", str(target)], timeout=30)
        if not loaded.ok:
            raise RuntimeError(f"could not load bwrap-userns-restrict: {loaded.logs}")


def _zfs_pools_ready(cfg: AgentConfig) -> bool:
    """Whether the zpool(s) the Docker ZFS dataset depends on already exist. Disk topology is an
    operator decision made outside host-prepare (see module docstring); until the pool(s) show up,
    Docker gets a plain install on its own default backing store instead of a hard failure."""
    if not _pool_exists(cfg.fast_pool):
        return False
    return not cfg.slow_is_zfs or _pool_exists(cfg.slow_pool)


def _create_docker_dataset(cfg: AgentConfig) -> None:
    created = run([
        "zfs", "create", "-o", "atime=off", "-o", "compression=lz4",
        "-o", f"mountpoint={cfg.docker_data_root}", cfg.docker_dataset,
    ], timeout=60)
    if not created.ok:
        raise RuntimeError(f"could not create Docker dataset {cfg.docker_dataset}: {created.logs}")


def _migrate_data_root_into_dataset(cfg: AgentConfig, root: Path) -> None:
    """Move aside whatever currently occupies the data-root, create the ZFS dataset at that same
    mountpoint, and copy the content back in. Covers both a fresh docker-ce install's just-created
    default state and a data-root Docker has actually been running against under a different
    backing store (e.g. the zpool(s) only just appeared on a node that already had Docker plainly
    installed) — either way nothing here is discarded until it is safely copied into the dataset."""
    backup = root.with_name(f"{root.name}.pre-zfs.bak")
    if backup.exists():
        shutil.rmtree(backup)
    root.rename(backup)
    root.mkdir(parents=True, exist_ok=True)
    _create_docker_dataset(cfg)
    copied = run(["cp", "-a", f"{backup}/.", str(root)], timeout=3600)
    if not copied.ok:
        raise RuntimeError(f"could not migrate {backup} into {cfg.docker_dataset}: {copied.logs}")
    shutil.rmtree(backup)


def _prepare_docker_storage(cfg: AgentConfig) -> bool:
    """Back Docker's data-root with a native ZFS dataset (storage-driver "zfs") once the fast (and,
    for a local ZFS cold tier, slow) pool(s) exist. Returns whether ZFS is now in use, so the
    daemon.json write can agree with what actually happened here. Until the pool(s) show up, this
    is a no-op and Docker is left on its plain default backing store.

    Converges to: a fast-pool dataset mounted at the data-root with the configured quota applied.
    Docker manages per-layer/per-container clones inside it directly; there is no filesystem to
    format and no /etc/fstab entry to maintain. If the data-root already has content when the pools
    first appear — Docker having run a while on its plain default store — that content is migrated
    into the new dataset rather than left behind.
    """
    if not _zfs_pools_ready(cfg):
        return False

    run(["systemctl", "stop", "docker.socket"], timeout=60)
    run(["systemctl", "stop", "docker"], timeout=120)

    exists = run(["zfs", "list", "-H", "-o", "name", cfg.docker_dataset], timeout=20).ok
    if not exists:
        root = Path(cfg.docker_data_root)
        root.mkdir(parents=True, exist_ok=True)
        if any(root.iterdir()):
            _migrate_data_root_into_dataset(cfg, root)
        else:
            _create_docker_dataset(cfg)
    else:
        mounted = run(["zfs", "mount", cfg.docker_dataset], timeout=30)
        if not mounted.ok and "already mounted" not in mounted.logs.lower():
            raise RuntimeError(f"could not mount {cfg.docker_dataset}: {mounted.logs}")

    quota = run(
        ["zfs", "set", f"quota={docker_quota_zfs_value(cfg.docker_quota_gb)}", cfg.docker_dataset],
        timeout=20,
    )
    if not quota.ok:
        raise RuntimeError(f"could not set quota on {cfg.docker_dataset}: {quota.logs}")
    return True


def prepare_host(cfg: AgentConfig) -> dict[str, Any]:
    """Configure one node. Re-running converges to the same files and daemon settings."""
    _require_root()
    gpu_present = _nvidia_hardware_count() > 0
    _ensure_base_packages()
    _ensure_nvidia_toolkit_if_present(gpu_present)

    if not Path("/proc/self/ns/user").exists():
        raise RuntimeError("kernel lacks user namespace support")
    try:
        proc_status = Path("/proc/self/status").read_text(encoding="utf-8")
    except OSError:
        proc_status = ""
    if "Seccomp:" not in proc_status:
        raise RuntimeError("kernel lacks seccomp filtering support")
    if not Path("/sys/kernel/security/apparmor/features/domain/stack").exists():
        raise RuntimeError("kernel lacks AppArmor namespace support")

    # Reserve the subordinate-ID range for the labdockremap account. The daemon no longer consumes
    # it (see merge_daemon_config — labs run --userns=host, not remapped), but keeping the exact
    # reservation stops the range being handed to another account and keeps the numeric mapping the
    # controller reports for cross-node cold-storage consistency stable.
    _ensure_account(cfg.userns_user)
    for path in (SUBUID, SUBGID):
        current = path.read_text(encoding="utf-8") if path.exists() else ""
        if subid_conflicts(current, cfg.userns_user, cfg.userns_start, cfg.userns_size):
            raise RuntimeError(f"requested subordinate-ID range overlaps another account in {path}")
        _write(path, replace_subid_entry(current, cfg.userns_user,
                                         cfg.userns_start, cfg.userns_size))

    sysctls = (
        "kernel.unprivileged_userns_clone = 1\n"
        "user.max_user_namespaces = 16384\n"
        # Labs run --userns=host, so IDE file watchers inside containers (VS Code Remote-SSH et
        # al.) draw from the host kernel's per-UID inotify budget. Distro defaults exhaust on large
        # workspaces and surface as ENOSPC in the student's editor. Each student owns a unique host
        # UID, so these caps are per student, not shared across the node.
        "fs.inotify.max_user_watches = 524288\n"
        "fs.inotify.max_user_instances = 1024\n"
    )
    if Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").exists():
        sysctls += "kernel.apparmor_restrict_unprivileged_userns = 1\n"
    _write(SYSCTL_FILE, sysctls)
    applied = run(["sysctl", "--system"], timeout=60)
    if not applied.ok:
        raise RuntimeError(applied.logs)

    _install_security_assets(cfg)

    docker_on_zfs = _prepare_docker_storage(cfg)

    current: dict[str, Any] = {}
    if DAEMON_JSON.exists():
        try:
            current = json.loads(DAEMON_JSON.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"invalid {DAEMON_JSON}: {exc}") from exc
    merged = merge_daemon_config(current, cfg, use_zfs=docker_on_zfs, gpu_present=gpu_present)
    _write(DAEMON_JSON, json.dumps(merged, indent=2) + "\n")

    if shutil.which("nvidia-ctk"):
        Path("/etc/cdi").mkdir(parents=True, exist_ok=True)
        generated = run([
            "nvidia-ctk", "cdi", "generate", "--output=/etc/cdi/nvidia.yaml"
        ], timeout=60)
        if not generated.ok:
            raise RuntimeError(generated.logs)
        units = run(["systemctl", "list-unit-files", "nvidia-cdi-refresh.path"], timeout=20)
        if units.ok and "nvidia-cdi-refresh.path" in units.stdout:
            enabled = run(["systemctl", "enable", "--now", "nvidia-cdi-refresh.path"], timeout=30)
            if not enabled.ok:
                raise RuntimeError(enabled.logs)

    restarted = run(["systemctl", "restart", "docker"], timeout=120)
    if not restarted.ok:
        raise RuntimeError(restarted.logs)
    return {
        "userns_user": cfg.userns_user,
        "subordinate_range": [cfg.userns_start, cfg.userns_size],
        "docker_data_root": cfg.docker_data_root,
        "docker_storage_driver": "zfs" if docker_on_zfs else "default",
        "docker_dataset": cfg.docker_dataset if docker_on_zfs else None,
        "docker_quota_gb": cfg.docker_quota_gb if docker_on_zfs else None,
        "gpu_cgroupfs_workaround": gpu_present,
        "seccomp_profile": cfg.seccomp_profile,
        "apparmor_profile": cfg.apparmor_profile,
    }
