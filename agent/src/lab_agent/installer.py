"""`lab-agent install` and the systemd service lifecycle.

Bootstrap on each node (as root):

    sudo uvx --from git+https://github.com/EC061/docker-mass-deployment#subdirectory=agent \
        lab-agent install

`install` removes any previous install, installs lab-agent PERSISTENTLY with ``uv tool install`` (so
systemd runs a stable on-disk binary, not the ephemeral ``uvx`` cache), writes a config TEMPLATE if
none exists (an existing config's token / node name / SMB settings are preserved on re-install), and
ENABLES — but deliberately does NOT START — the service. The operator then edits the config and runs
``lab-agent start``. ``lab-agent upgrade`` reinstalls the newest version and restarts.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

from .config import AgentConfig, render_config

SYSTEMD_UNIT_PATH = Path("/etc/systemd/system/lab-agent.service")
STATE_DIR = Path("/var/lib/lab-agent")
SERVICE = "lab-agent.service"

# The agent package source: the repo's `agent` subdirectory. install + upgrade install from here.
REPO_URL = "git+https://github.com/EC061/docker-mass-deployment"
REPO_SUBDIR = "subdirectory=agent"
# Unpinned (newest) spec — the simple default. Pass a ref to pin to a released tag/commit (I-02).
REPO_SPEC = f"{REPO_URL}#{REPO_SUBDIR}"


def _repo_spec(ref: str | None = None) -> str:
    """uv package spec for the agent, optionally pinned to a git ref (tag/branch/commit)."""
    return f"{REPO_URL}@{ref}#{REPO_SUBDIR}" if ref else REPO_SPEC


def _require_root() -> None:
    if os.geteuid() != 0:
        raise PermissionError(
            "this command must run as root (manages /etc + a systemd service). Re-run with sudo."
        )


def _run(cmd: list[str]) -> tuple[int, str]:
    """Run a command, capturing combined stdout+stderr. Returns (returncode, output)."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, str(exc)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def _sudo_user_home() -> str | None:
    """Home of the user behind ``sudo`` (uv is usually installed there, not in root's PATH)."""
    user = os.environ.get("SUDO_USER")
    if not user:
        return None
    try:
        import pwd

        return pwd.getpwnam(user).pw_dir
    except (KeyError, ImportError):
        return None


def _find_uv() -> str | None:
    """Locate the ``uv`` binary. Under sudo it is often only on the invoking user's PATH, so also
    probe the usual per-user install locations (including the SUDO_USER's home)."""
    found = shutil.which("uv")
    if found:
        return found
    candidates: list[Path] = []
    for base in (os.environ.get("HOME"), _sudo_user_home()):
        if base:
            candidates += [Path(base) / ".local/bin/uv", Path(base) / ".cargo/bin/uv"]
    candidates += [Path("/root/.local/bin/uv"), Path("/usr/local/bin/uv"), Path("/usr/bin/uv")]
    for c in candidates:
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)
    return None


def _is_ephemeral(path: str) -> bool:
    """A uvx/cache path is not stable enough for systemd ExecStart (it can be GC'd)."""
    return "/uvx" in path or "/.cache/" in path or "/tmp/" in path


def _is_file(p: Path) -> bool:
    """``Path.is_file()`` tolerant of EACCES (statting inside /root as a non-root user raises)."""
    try:
        return p.is_file()
    except OSError:
        return False


def _user_bin_candidates() -> list[Path]:
    """Likely locations of a uv-tool-installed lab-agent executable (the user bin dir)."""
    cands: list[Path] = []
    bin_home = os.environ.get("XDG_BIN_HOME")
    if bin_home:
        cands.append(Path(bin_home) / "lab-agent")
    for base in (os.environ.get("HOME"), "/root", _sudo_user_home()):
        if base:
            cands.append(Path(base) / ".local/bin/lab-agent")
    return cands


def _resolve_executable() -> str:
    """Absolute path to a STABLE lab-agent entrypoint for systemd ExecStart. Prefers a real binary
    on PATH (skipping the ephemeral uvx cache), then the uv-tool user bin dirs, and only falls back
    to ``python -m`` if nothing persistent is found (e.g. running from a checkout in tests)."""
    exe = shutil.which("lab-agent")
    if exe and not _is_ephemeral(exe):
        return exe
    for cand in _user_bin_candidates():
        if _is_file(cand):
            return str(cand)
    # Nothing stable found (only an ephemeral uvx copy, or none): a `python -m` line at least names
    # a concrete interpreter. The real install path avoids this by uv-tool-installing a stable copy.
    return f"{sys.executable} -m lab_agent.cli"


def render_unit(config_path: Path, exec_path: str | None = None) -> str:
    exec_start = f"{exec_path or _resolve_executable()} run"
    return f"""[Unit]
Description=Lab Manager node agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
Environment=LAB_AGENT_CONFIG={config_path}
ExecStart={exec_start}
Restart=always
RestartSec=5
# The agent shells out to zfs/docker/useradd, which require root.
User=root

[Install]
WantedBy=multi-user.target
"""


def render_config_template(cfg: AgentConfig) -> str:
    """A config.toml with operator-editable fields and inline guidance. Values default from ``cfg``
    (a scripted install can pre-fill them via flags) but are meant to be edited by hand."""
    header = (
        "# lab-agent configuration. Edit the values below, then: sudo lab-agent start\n"
        "#\n"
        "# Required to connect:\n"
        "#   controller_url  controller WebSocket URL, e.g. wss://lab.example.net\n"
        "#   token           this node's token from the controller UI (Nodes -> Provision)\n"
        "#   node_name       this node's identity (lowercase a-z 0-9 -, must match the UI)\n"
        "#\n"
        "# Cold storage (slow tier):\n"
        '#   slow_backend    "zfs" (local ZFS slow pool) or "smb" (an external CIFS/SMB mount)\n'
        '#   slow_path       "smb" backend: active cold share mount (default /cold-storage)\n'
        '#   cold_mount_root local-ZFS backend: lab dataset mount root (default /cold-storage)\n'
        "# (The cold-storage OWNER for an SMB client is chosen in the controller UI, not here.)\n"
    )
    # Default an empty controller_url to an obvious placeholder so the operator sees what to edit.
    if not cfg.controller_url:
        cfg = replace(cfg, controller_url="wss://CHANGE_ME")
    return header + render_config(cfg)


def _uv_tool_exec_path(uv: str) -> str:
    """Where ``uv tool install`` placed the lab-agent executable (the user bin dir)."""
    for cand in _user_bin_candidates():
        if _is_file(cand):
            return str(cand)
    return _resolve_executable()


def _install_tool(ref: str | None = None) -> str:
    """Install lab-agent persistently with uv and return the stable executable path. If uv is not
    found, fall back to the currently-resolvable binary (the running uvx copy) with a warning."""
    uv = _find_uv()
    if uv is None:
        print(
            "warning: `uv` not found; cannot install a persistent copy. systemd will reference the "
            "current binary, which may be an ephemeral uvx cache. Install uv, then re-run install.",
            file=sys.stderr,
        )
        return _resolve_executable()
    rc, out = _run([uv, "tool", "install", "--force", _repo_spec(ref)])
    if rc != 0:
        raise RuntimeError(f"`uv tool install` failed (rc={rc}): {out.strip()}")
    return _uv_tool_exec_path(uv)


def _cleanup_previous_install() -> None:
    """Remove any previous install so a re-install is clean. Every step is best-effort: a fresh node
    has none of this, and a partial earlier install should still be fully cleanable."""
    os.system(f"systemctl stop {SERVICE} 2>/dev/null")
    os.system(f"systemctl disable {SERVICE} 2>/dev/null")
    try:
        SYSTEMD_UNIT_PATH.unlink()
    except OSError:
        pass
    os.system("systemctl daemon-reload")
    uv = _find_uv()
    if uv:
        _run([uv, "tool", "uninstall", "lab-agent"])


def install(
    cfg: AgentConfig, config_path: Path, *, enable: bool = True, ref: str | None = None
) -> dict[str, str]:
    """Clean any previous install, install lab-agent persistently, write the config (template if
    absent; existing config preserved), and write+enable the unit WITHOUT starting it. ``ref`` pins
    the install to a git tag/commit (default: newest)."""
    _require_root()
    results: dict[str, str] = {}

    _cleanup_previous_install()
    results["cleanup"] = "previous install removed (if any)"

    exec_path = _install_tool(ref)
    results["lab-agent"] = exec_path

    # Preserve an existing config on re-install (don't clobber a configured token/name/SMB).
    if config_path.exists():
        results["config"] = f"{config_path} (kept existing)"
    else:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(render_config_template(cfg))
        config_path.chmod(0o600)  # token is a secret
        results["config"] = f"{config_path} (template written — edit before starting)"

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    SYSTEMD_UNIT_PATH.write_text(render_unit(config_path, exec_path))
    results["unit"] = str(SYSTEMD_UNIT_PATH)

    if enable:
        os.system("systemctl daemon-reload")
        os.system(f"systemctl enable {SERVICE}")  # start on boot, but NOT now
        results["status"] = "installed; enabled on boot but NOT started"
    else:
        results["status"] = "written (not enabled)"
    return results


def start_service() -> None:
    """Enable + start the service (idempotent)."""
    _require_root()
    os.system(f"systemctl enable {SERVICE}")
    rc = os.system(f"systemctl start {SERVICE}")
    if rc != 0:
        raise RuntimeError("failed to start lab-agent.service; check `journalctl -u lab-agent`")


def stop_service() -> None:
    _require_root()
    os.system(f"systemctl stop {SERVICE}")


def upgrade(ref: str | None = None) -> dict[str, str]:
    """Reinstall lab-agent from the repo (newest, or a pinned ``ref``) and restart the service."""
    _require_root()
    uv = _find_uv()
    if uv is None:
        raise RuntimeError("`uv` not found; cannot upgrade. Install uv, then re-run.")
    rc, out = _run([uv, "tool", "install", "--force", "--reinstall", _repo_spec(ref)])
    if rc != 0:
        raise RuntimeError(f"upgrade failed (rc={rc}): {out.strip()}")
    exec_path = _uv_tool_exec_path(uv)
    os.system("systemctl daemon-reload")
    os.system(f"systemctl restart {SERVICE}")
    _, ver = _run([exec_path, "--version"])
    return {"lab-agent": exec_path, "version": ver.strip() or "(unknown)"}


def service_status() -> dict[str, str]:
    """systemd active/enabled state, for `lab-agent doctor`."""
    _, active = _run(["systemctl", "is-active", SERVICE])
    _, enabled = _run(["systemctl", "is-enabled", SERVICE])
    return {"active": active.strip() or "unknown", "enabled": enabled.strip() or "unknown"}
