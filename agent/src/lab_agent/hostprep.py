"""Idempotent host preparation for Docker userns-remap and the Codex/bubblewrap profiles."""

from __future__ import annotations

import grp
import json
import os
import pwd
import shutil
from importlib import resources
from pathlib import Path
from typing import Any

from .config import AgentConfig
from .executors.base import run

DAEMON_JSON = Path("/etc/docker/daemon.json")
SUBUID = Path("/etc/subuid")
SUBGID = Path("/etc/subgid")
SYSCTL_FILE = Path("/etc/sysctl.d/90-lab-codex.conf")
APPARMOR_DEST = Path("/etc/apparmor.d/lab-codex")


def mapped_host_id(cfg: AgentConfig, container_id: int) -> int:
    if not 0 <= container_id < cfg.userns_size:
        raise ValueError(f"container id {container_id} is outside the subordinate-id range")
    return cfg.userns_start + container_id


def merge_daemon_config(current: dict[str, Any], cfg: AgentConfig) -> dict[str, Any]:
    merged = dict(current)
    merged["userns-remap"] = cfg.userns_user
    merged["data-root"] = cfg.docker_data_root
    return merged


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


def prepare_host(cfg: AgentConfig) -> dict[str, Any]:
    """Configure one node. Re-running converges to the same files and daemon settings."""
    _require_root()
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
    )
    if Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").exists():
        sysctls += "kernel.apparmor_restrict_unprivileged_userns = 1\n"
    _write(SYSCTL_FILE, sysctls)
    applied = run(["sysctl", "--system"], timeout=60)
    if not applied.ok:
        raise RuntimeError(applied.logs)

    _install_security_assets(cfg)
    current: dict[str, Any] = {}
    if DAEMON_JSON.exists():
        try:
            current = json.loads(DAEMON_JSON.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"invalid {DAEMON_JSON}: {exc}") from exc
    Path(cfg.docker_data_root).mkdir(parents=True, exist_ok=True)
    _write(DAEMON_JSON, json.dumps(merge_daemon_config(current, cfg), indent=2) + "\n")

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
        "seccomp_profile": cfg.seccomp_profile,
        "apparmor_profile": cfg.apparmor_profile,
    }
