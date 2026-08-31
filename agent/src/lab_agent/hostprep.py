"""Idempotent host preparation for Docker, storage, and NVIDIA CDI.

Besides converging config, this installs everything host-prepare itself depends on: Docker Engine
(from Docker's official apt repo), ZFS userspace tools, and — only when NVIDIA GPU hardware is
present — the CDI-only NVIDIA Container Toolkit base package. It never installs the NVIDIA kernel
driver itself (needs a reboot and hardware-specific version choice) or creates zpools (disk topology
is the operator's call); both remain documented manual prerequisites.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .config import AgentConfig
from .executors.base import run
from .storage import service as storage_service
from .system import _nvidia_hardware_count, _pool_exists

DAEMON_JSON = Path("/etc/docker/daemon.json")
SYSCTL_FILE = Path("/etc/sysctl.d/90-lab-agent.conf")
LEGACY_SYSCTL_FILE = Path("/etc/sysctl.d/90-lab-codex.conf")
LEGACY_SECCOMP_PROFILE = Path("/etc/lab-agent/security/lab-codex-seccomp.json")
LEGACY_APPARMOR_PROFILE = Path("/etc/apparmor.d/lab-codex")
LEGACY_DISTRO_NAMESPACE_PROFILE = Path("/etc/apparmor.d/bwrap-userns-restrict")
LEGACY_NVIDIA_CDI_SPEC = Path("/etc/cdi/nvidia.yaml")
STORAGE_UNIT_PATH = Path("/etc/systemd/system/lab-storage-mounts.service")
STORAGE_UNIT = "lab-storage-mounts.service"

# Packages available from the default Ubuntu archive. ca-certificates/curl/gnupg are fetched first
# because adding the Docker/NVIDIA apt repos below needs them.
PREREQ_APT_PACKAGES = ("ca-certificates", "curl", "gnupg")
CORE_APT_PACKAGES = ("zfsutils-linux", "apparmor")
# Installed only when a tier is configured with the mergerfs backend. `attr` provides
# getfattr/setfattr, which is how a branch is added to a LIVE mergerfs mount (no remount, so running
# lab containers keep their bind mount); `fuse3` provides fusermount3 for unmounting.
MERGERFS_APT_PACKAGES = ("mergerfs", "attr", "fuse3")
DOCKER_APT_PACKAGES = (
    "docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin",
)
NVIDIA_APT_PACKAGES = ("nvidia-container-toolkit-base",)
LEGACY_NVIDIA_APT_PACKAGES = (
    "nvidia-container-toolkit", "nvidia-container-runtime", "nvidia-docker2",
)

DOCKER_GPG_KEY = Path("/etc/apt/keyrings/docker.asc")
DOCKER_APT_LIST = Path("/etc/apt/sources.list.d/docker.list")
NVIDIA_GPG_KEY = Path("/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg")
NVIDIA_APT_LIST = Path("/etc/apt/sources.list.d/nvidia-container-toolkit.list")
NVIDIA_GPG_KEY_URL = "https://nvidia.github.io/libnvidia-container/gpgkey"
NVIDIA_APT_LIST_URL = (
    "https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list"
)


LEGACY_NVIDIA_CGROUPFS_EXEC_OPT = "native.cgroupdriver=cgroupfs"


def merge_daemon_config(
    current: dict[str, Any], cfg: AgentConfig, *, use_zfs: bool
) -> dict[str, Any]:
    merged = dict(current)
    # Managed labs rely on identity numeric UIDs across local and SMB storage, so the daemon uses
    # Docker's normal non-remapped default. Drop any stale key an earlier agent left behind.
    merged.pop("userns-remap", None)
    if merged.get("default-runtime") == "nvidia":
        merged.pop("default-runtime")
    runtimes = dict(merged.get("runtimes", {}))
    runtimes.pop("nvidia", None)
    if runtimes:
        merged["runtimes"] = runtimes
    else:
        merged.pop("runtimes", None)
    merged["data-root"] = cfg.docker_data_root
    if use_zfs:
        # The data-root is a native ZFS dataset; the zfs graphdriver clones it per layer/container
        # and honours --storage-opt size via ZFS's own "quota" property.
        merged["storage-driver"] = "zfs"
    # CDI records GPU device access in the OCI config, so the old cgroupfs workaround is no longer
    # needed. Remove only the exact value previously managed here and preserve operator settings.
    exec_opts = [o for o in merged.get("exec-opts", [])
                 if o != LEGACY_NVIDIA_CGROUPFS_EXEC_OPT]
    if exec_opts:
        merged["exec-opts"] = exec_opts
    else:
        merged.pop("exec-opts", None)
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


def _ensure_mergerfs_if_required(cfg: AgentConfig) -> bool:
    """Install mergerfs when any tier is configured with the mergerfs backend. Idempotent.

    An operator should never have to install it by hand: a node whose config says a tier unions
    several pools cannot mount that tier at all without it.
    """
    if not any(tier.uses_mergerfs for tier in cfg.storage.tiers()):
        return False
    return ensure_mergerfs_available()


def ensure_mergerfs_available() -> bool:
    """Install mergerfs plus its live-reconfiguration helpers, idempotently.

    This is also called by the online add-pool operation: a node bootstrapped with one drive did
    not need mergerfs on day one, but adding its second drive must not require a separate manual
    package-install step.
    """
    if _missing_packages(MERGERFS_APT_PACKAGES):
        _apt_update()
        _apt_install(MERGERFS_APT_PACKAGES)
    return True


def _ensure_nvidia_cdi_if_present(gpu_present: bool) -> None:
    """Install the latest CDI-only toolkit package when NVIDIA hardware is present.

    Running apt install even when the package exists intentionally converges an existing node to
    the newest version published by NVIDIA's stable repository. The kernel driver remains a manual,
    reboot-requiring operator step.
    """
    if not gpu_present:
        return
    _ensure_nvidia_apt_repo()
    _apt_update()
    result = run([
        "apt-get", "install", "-y",
        "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
        *NVIDIA_APT_PACKAGES,
    ], timeout=600)
    if not result.ok:
        raise RuntimeError(f"apt-get install failed for {', '.join(NVIDIA_APT_PACKAGES)}: "
                           f"{result.logs}")
    installed_legacy = [pkg for pkg in LEGACY_NVIDIA_APT_PACKAGES if _dpkg_installed(pkg)]
    if installed_legacy:
        removed = run(["apt-get", "remove", "-y", *installed_legacy], timeout=600)
        if not removed.ok:
            raise RuntimeError(f"could not remove legacy NVIDIA runtime packages: {removed.logs}")


def _refresh_nvidia_cdi(gpu_present: bool) -> None:
    if not gpu_present:
        return
    if LEGACY_NVIDIA_CDI_SPEC.exists():
        LEGACY_NVIDIA_CDI_SPEC.unlink()
    enabled = run([
        "systemctl", "enable", "--now",
        "nvidia-cdi-refresh.path", "nvidia-cdi-refresh.service",
    ], timeout=60)
    if not enabled.ok:
        raise RuntimeError(f"could not enable NVIDIA CDI refresh: {enabled.logs}")


def _remove_legacy_security_assets() -> None:
    """Remove profiles installed by older agents before Docker's defaults were restored."""
    for profile in (LEGACY_APPARMOR_PROFILE, LEGACY_DISTRO_NAMESPACE_PROFILE):
        if profile.exists():
            run(["apparmor_parser", "-R", str(profile)], timeout=30)
            profile.unlink()
    if LEGACY_SECCOMP_PROFILE.exists():
        LEGACY_SECCOMP_PROFILE.unlink()


def _docker_pool_ready(cfg: AgentConfig) -> bool:
    """Whether Docker's independently configured native-ZFS pool exists.

    A missing lab-storage branch must not keep Docker on a plain filesystem when Docker's own pool
    is healthy.  The whole point of separating ``storage.docker`` from the logical fast tier is that
    these lifecycles are independent.
    """
    return _pool_exists(cfg.storage.docker.pool)


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
    if not _docker_pool_ready(cfg):
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


def render_storage_unit(config_path: str, exec_path: str) -> str:
    """A systemd unit that brings the tier mounts up at boot, in the right order.

    Why a oneshot service rather than generated ``.mount`` units: the set of per-lab mergerfs mounts
    is dynamic (it changes whenever a lab is created or destroyed), and — crucially — the branch
    list for each mount must be computed from LIVE ZFS mount state so a missing disk is dropped
    instead of being replaced by an empty root-filesystem directory. A static unit cannot make that
    decision; ``lab-agent storage mount`` can, and is idempotent, so re-running it converges.

    Ordering: after ZFS has imported and mounted its datasets, before Docker starts (so a lab
    container never comes up against a half-mounted tier) and before the agent.
    """
    return f"""[Unit]
Description=Lab storage: ZFS tier roots and per-lab mergerfs mounts
DefaultDependencies=no
After=zfs.target zfs-mount.service local-fs.target
Wants=zfs.target zfs-mount.service
Before=docker.service lab-agent.service shutdown.target
Conflicts=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=LAB_AGENT_CONFIG={config_path}
ExecStart={exec_path} storage mount
# Unmount the unions before ZFS tears its datasets down (systemd stops us first, being After= it).
ExecStop={exec_path} storage unmount
TimeoutStartSec=300
User=root

[Install]
WantedBy=multi-user.target
"""


def _install_storage_unit(cfg: AgentConfig, config_path: str) -> None:
    """Write + enable the boot-time storage mount unit. Idempotent."""
    from .installer import _resolve_executable

    _write(STORAGE_UNIT_PATH, render_storage_unit(config_path, _resolve_executable()))
    run(["systemctl", "daemon-reload"], timeout=60)
    run(["systemctl", "enable", STORAGE_UNIT], timeout=60)


def _prepare_lab_storage(cfg: AgentConfig) -> dict[str, Any]:
    """Converge the lab tiers: per-pool container datasets + per-lab union mounts, and make the
    whole thing survive a reboot via the systemd unit above.

    Skipped (not failed) while the pools do not exist yet, exactly like the Docker dataset: disk
    topology is an operator/WebUI decision that happens outside host-prepare.
    """
    config_path = str(os.environ.get("LAB_AGENT_CONFIG", "/etc/lab-agent/config.toml"))
    _install_storage_unit(cfg, config_path)
    try:
        # Reconcile even when only SOME configured pools exist.  The storage service filters on
        # actual ZFS mount state and deliberately brings mergerfs up over surviving branches; a
        # global all-pools gate would defeat degraded operation after a disk failure.
        return storage_service.reconcile_mounts(cfg)
    except Exception as exc:  # never make host-prepare fail on a storage edge case
        return {"error": str(exc)}


def prepare_host(cfg: AgentConfig) -> dict[str, Any]:
    """Configure one node. Re-running converges to the same files and daemon settings."""
    _require_root()
    gpu_present = _nvidia_hardware_count() > 0
    _ensure_base_packages()
    mergerfs_installed = _ensure_mergerfs_if_required(cfg)
    _ensure_nvidia_cdi_if_present(gpu_present)
    _remove_legacy_security_assets()

    sysctls = (
        # IDE file watchers inside containers draw from the host kernel's per-UID inotify budget.
        # Distro defaults exhaust on large
        # workspaces and surface as ENOSPC in the student's editor. Each student owns a unique host
        # UID, so these caps are per student, not shared across the node.
        "fs.inotify.max_user_watches = 524288\n"
        "fs.inotify.max_user_instances = 1024\n"
    )
    if LEGACY_SYSCTL_FILE.exists():
        LEGACY_SYSCTL_FILE.unlink()
    _write(SYSCTL_FILE, sysctls)
    applied = run(["sysctl", "--system"], timeout=60)
    if not applied.ok:
        raise RuntimeError(applied.logs)

    docker_on_zfs = _prepare_docker_storage(cfg)
    storage_report = _prepare_lab_storage(cfg)

    current: dict[str, Any] = {}
    if DAEMON_JSON.exists():
        try:
            current = json.loads(DAEMON_JSON.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"invalid {DAEMON_JSON}: {exc}") from exc
    merged = merge_daemon_config(current, cfg, use_zfs=docker_on_zfs)
    _write(DAEMON_JSON, json.dumps(merged, indent=2) + "\n")

    _refresh_nvidia_cdi(gpu_present)

    restarted = run(["systemctl", "restart", "docker"], timeout=120)
    if not restarted.ok:
        raise RuntimeError(restarted.logs)
    return {
        "docker_data_root": cfg.docker_data_root,
        "docker_storage_driver": "zfs" if docker_on_zfs else "default",
        "docker_dataset": cfg.docker_dataset if docker_on_zfs else None,
        "docker_pool": cfg.storage.docker.pool,
        "docker_quota_gb": cfg.docker_quota_gb if docker_on_zfs else None,
        "mergerfs_installed": mergerfs_installed,
        "storage_tiers": {
            tier.name: {"backend": tier.backend, "pools": list(tier.pools),
                        "mount_root": tier.mount_root}
            for tier in cfg.storage.tiers()
        },
        "storage_mounts": storage_report,
        "storage_unit": str(STORAGE_UNIT_PATH),
        "nvidia_cdi_spec": "/var/run/cdi/nvidia.yaml" if gpu_present else None,
    }
