from pathlib import Path

import pytest

from lab_agent import installer
from lab_agent.config import AgentConfig


def _cfg(**kw):
    base = dict(controller_url="wss://ctl:8443", token="secret", node_name="node-1")
    base.update(kw)
    return AgentConfig(**base)


# --------------------------------------------------------------------------- exec-path resolution


def test_resolve_executable_prefers_stable_path_binary(monkeypatch):
    monkeypatch.setattr(installer.shutil, "which", lambda _: "/usr/local/bin/lab-agent")
    assert installer._resolve_executable() == "/usr/local/bin/lab-agent"


def test_resolve_executable_skips_ephemeral_uvx_cache(monkeypatch):
    # A uvx cache path must not be baked into the unit; with no stable copy, fall back to python -m.
    monkeypatch.setattr(installer.shutil, "which",
                        lambda _: "/home/u/.cache/uv/archive-x/bin/lab-agent")
    monkeypatch.setattr(installer, "_sudo_user_home", lambda: None)
    monkeypatch.delenv("XDG_BIN_HOME", raising=False)
    monkeypatch.setenv("HOME", "/nonexistent-home")
    monkeypatch.setattr(installer.sys, "executable", "/opt/py/bin/python")
    # /home/u/.cache/... is ephemeral -> skipped; no per-user binary exists -> python -m fallback.
    assert installer._resolve_executable() == "/opt/py/bin/python -m lab_agent.cli"


def test_resolve_executable_falls_back_to_python_module(monkeypatch):
    monkeypatch.setattr(installer.shutil, "which", lambda _: None)
    monkeypatch.setattr(installer, "_sudo_user_home", lambda: None)
    monkeypatch.delenv("XDG_BIN_HOME", raising=False)
    monkeypatch.setenv("HOME", "/nonexistent-home")
    monkeypatch.setattr(installer.sys, "executable", "/opt/py/bin/python")
    assert installer._resolve_executable() == "/opt/py/bin/python -m lab_agent.cli"


# --------------------------------------------------------------------------- unit + config rendering


def test_render_unit_contains_exec_start_and_config(monkeypatch):
    monkeypatch.setattr(installer.shutil, "which", lambda _: "/usr/bin/lab-agent")
    unit = installer.render_unit(Path("/etc/lab-agent/config.toml"))
    assert "ExecStart=/usr/bin/lab-agent run" in unit
    assert "Environment=LAB_AGENT_CONFIG=/etc/lab-agent/config.toml" in unit
    assert "Restart=always" in unit
    assert "User=root" in unit
    assert "WantedBy=multi-user.target" in unit


def test_render_unit_honors_explicit_exec_path():
    unit = installer.render_unit(Path("/etc/lab-agent/config.toml"), "/root/.local/bin/lab-agent")
    assert "ExecStart=/root/.local/bin/lab-agent run" in unit


def test_render_config_template_has_guidance_and_agent_table():
    text = installer.render_config_template(_cfg())
    assert text.lstrip().startswith("#")  # leading guidance comments
    assert "sudo lab-agent start" in text
    assert "[agent]" in text
    assert 'controller_url = "wss://ctl:8443"' in text


def test_render_config_template_placeholders_empty_controller_url():
    text = installer.render_config_template(_cfg(controller_url="", token=""))
    assert "wss://CHANGE_ME" in text


# --------------------------------------------------------------------------- install


def test_install_requires_root(monkeypatch, tmp_path):
    monkeypatch.setattr(installer.os, "geteuid", lambda: 1000)
    with pytest.raises(PermissionError):
        installer.install(_cfg(), tmp_path / "config.toml")


def _redirect_system_dirs(monkeypatch, tmp_path):
    """Point the system install dirs into tmp_path — a test must never touch the real /usr/local."""
    bin_dir = tmp_path / "usr-local-bin"
    monkeypatch.setattr(installer, "SYSTEM_BIN_DIR", bin_dir)
    monkeypatch.setattr(installer, "SYSTEM_EXEC_PATH", bin_dir / "lab-agent")
    monkeypatch.setattr(installer, "SYSTEM_TOOL_DIR", tmp_path / "opt-tools")
    monkeypatch.setattr(installer, "SYSTEM_PYTHON_DIR", tmp_path / "opt-python")
    return bin_dir


def _stub_install_internals(monkeypatch, tmp_path):
    """Avoid real uv / systemctl: stub the persistent install + cleanup, capture os.system calls."""
    monkeypatch.setattr(installer.os, "geteuid", lambda: 0)
    monkeypatch.setattr(installer, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(installer, "SYSTEMD_UNIT_PATH", tmp_path / "lab-agent.service")
    monkeypatch.setattr(installer, "_cleanup_previous_install", lambda: None)
    monkeypatch.setattr(installer, "_install_tool", lambda ref=None: "/usr/local/bin/lab-agent")
    _redirect_system_dirs(monkeypatch, tmp_path)
    calls: list[str] = []
    monkeypatch.setattr(installer.os, "system", lambda cmd: calls.append(cmd) or 0)
    return calls


def test_install_writes_template_enables_but_does_not_start(monkeypatch, tmp_path):
    calls = _stub_install_internals(monkeypatch, tmp_path)
    config_path = tmp_path / "config.toml"
    result = installer.install(_cfg(), config_path, enable=True)

    assert config_path.exists()
    assert 'controller_url = "wss://ctl:8443"' in config_path.read_text()
    assert "template written" in result["config"]
    assert (tmp_path / "state").is_dir()
    unit_text = (tmp_path / "lab-agent.service").read_text()
    assert "ExecStart=/usr/local/bin/lab-agent run" in unit_text
    assert result["lab-agent"] == "/usr/local/bin/lab-agent"
    assert result["status"] == "installed; enabled on boot but NOT started"
    assert any("daemon-reload" in c for c in calls)
    assert any(c == "systemctl enable lab-agent.service" for c in calls)
    # Crucially it must NOT start the service (no `--now`, no `start`).
    assert not any("--now" in c or "start" in c for c in calls)


def test_install_preserves_existing_config(monkeypatch, tmp_path):
    _stub_install_internals(monkeypatch, tmp_path)
    config_path = tmp_path / "config.toml"
    config_path.write_text("[agent]\ncontroller_url = \"wss://keep\"\ntoken = \"keepme\"\n")
    result = installer.install(_cfg(controller_url="wss://other", token="other"), config_path)
    # The existing config is left untouched (token/name/SMB preserved on re-install).
    assert "keepme" in config_path.read_text()
    assert "kept existing" in result["config"]


def test_install_tool_targets_system_paths_not_root(monkeypatch, tmp_path):
    """The core of the fix: /root is 0700, so a per-user uv layout is unreachable for everyone
    else on the node. The install must land in /usr/local/bin + /opt."""
    bin_dir = _redirect_system_dirs(monkeypatch, tmp_path)
    uv_src = tmp_path / "root-local-bin"
    uv_src.mkdir()
    for name in ("uv", "uvx"):
        (uv_src / name).write_text(f"#!/bin/sh\n# {name}\n")
    monkeypatch.setattr(installer, "_find_uv", lambda: str(uv_src / "uv"))
    calls: list[tuple[list[str], dict | None]] = []

    def fake_run(cmd, env=None):
        (bin_dir / "lab-agent").write_text("#!/bin/sh\n")  # what uv would create
        calls.append((cmd, env))
        return 0, ""

    monkeypatch.setattr(installer, "_run", fake_run)

    assert installer._install_tool() == str(bin_dir / "lab-agent")
    cmd, env = calls[0]
    # uv is invoked from its new system location, not the private home it was found in.
    assert cmd[0] == str(bin_dir / "uv")
    assert env["UV_TOOL_BIN_DIR"] == str(bin_dir)
    assert env["UV_TOOL_DIR"] == str(tmp_path / "opt-tools")
    assert env["UV_PYTHON_INSTALL_DIR"] == str(tmp_path / "opt-python")


def test_install_uv_on_path_copies_uv_and_uvx(monkeypatch, tmp_path):
    """`sudo` strips ~/.local/bin, so uv itself has to be on the system PATH for the documented
    `sudo uvx --from ... lab-agent upgrade` bootstrap to work at all."""
    bin_dir = _redirect_system_dirs(monkeypatch, tmp_path)
    src = tmp_path / "home-local-bin"
    src.mkdir()
    (src / "uv").write_text("uv binary")
    (src / "uvx").write_text("uvx binary")

    assert installer._install_uv_on_path(str(src / "uv")) == str(bin_dir / "uv")
    assert (bin_dir / "uv").read_text() == "uv binary"
    assert (bin_dir / "uvx").read_text() == "uvx binary"
    # World-executable, or an ordinary user still cannot run it.
    assert (bin_dir / "uv").stat().st_mode & 0o755 == 0o755
    assert not list(bin_dir.glob(".*.new"))  # no temp file left behind


def test_install_uv_on_path_is_a_noop_when_already_system_wide(monkeypatch, tmp_path):
    bin_dir = _redirect_system_dirs(monkeypatch, tmp_path)
    bin_dir.mkdir(parents=True)
    (bin_dir / "uv").write_text("uv binary")
    assert installer._install_uv_on_path(str(bin_dir / "uv")) == str(bin_dir / "uv")


def test_ensure_system_dirs_creates_missing_usr_local_bin(monkeypatch, tmp_path):
    """Some minimal Ubuntu images ship no /usr/local/bin at all — `ln` and uv both fail on it."""
    bin_dir = _redirect_system_dirs(monkeypatch, tmp_path)
    assert not bin_dir.exists()
    installer._ensure_system_dirs()
    assert bin_dir.is_dir() and bin_dir.stat().st_mode & 0o755 == 0o755


def test_install_no_enable_skips_systemctl(monkeypatch, tmp_path):
    calls = _stub_install_internals(monkeypatch, tmp_path)
    result = installer.install(_cfg(), tmp_path / "config.toml", enable=False)
    assert result["status"] == "written (not enabled)"
    assert calls == []


# --------------------------------------------------------------------------- lifecycle helpers


def test_start_service_enables_and_starts(monkeypatch):
    monkeypatch.setattr(installer.os, "geteuid", lambda: 0)
    calls: list[str] = []
    monkeypatch.setattr(installer.os, "system", lambda cmd: calls.append(cmd) or 0)
    installer.start_service()
    assert calls == ["systemctl enable lab-agent.service", "systemctl start lab-agent.service"]


def test_start_service_requires_root(monkeypatch):
    monkeypatch.setattr(installer.os, "geteuid", lambda: 1000)
    with pytest.raises(PermissionError):
        installer.start_service()


def test_stop_service_stops(monkeypatch):
    monkeypatch.setattr(installer.os, "geteuid", lambda: 0)
    calls: list[str] = []
    monkeypatch.setattr(installer.os, "system", lambda cmd: calls.append(cmd) or 0)
    installer.stop_service()
    assert calls == ["systemctl stop lab-agent.service"]


def test_upgrade_reinstalls_and_restarts(monkeypatch, tmp_path):
    bin_dir = _redirect_system_dirs(monkeypatch, tmp_path)
    monkeypatch.setattr(installer.os, "geteuid", lambda: 0)
    monkeypatch.setattr(installer, "_find_uv", lambda: str(bin_dir / "uv"))
    monkeypatch.setattr(installer, "_uv_tool_exec_path", lambda uv: str(bin_dir / "lab-agent"))
    monkeypatch.setattr(installer, "SYSTEMD_UNIT_PATH", tmp_path / "lab-agent.service")
    run_calls: list[list[str]] = []

    def fake_run(cmd, env=None):
        run_calls.append(cmd)
        return (0, "lab-agent 0.1.0\n") if cmd[-1] == "--version" else (0, "")

    monkeypatch.setattr(installer, "_run", fake_run)
    sys_calls: list[str] = []
    monkeypatch.setattr(installer.os, "system", lambda cmd: sys_calls.append(cmd) or 0)

    result = installer.upgrade()
    uv = str(bin_dir / "uv")
    assert [uv, "tool", "install", "--force", "--reinstall", installer.REPO_SPEC] in run_calls
    assert any("restart lab-agent.service" in c for c in sys_calls)
    assert result["version"] == "lab-agent 0.1.0"


def test_upgrade_migrates_a_root_install_to_the_system_paths(monkeypatch, tmp_path):
    """A node installed under the old per-user layout must be moved, not merely re-installed:
    uninstall the /root copy, then rewrite the unit's ExecStart at the new path."""
    bin_dir = _redirect_system_dirs(monkeypatch, tmp_path)
    unit = tmp_path / "lab-agent.service"
    unit.write_text(installer.render_unit(Path("/etc/lab-agent/config.toml"),
                                          "/root/.local/bin/lab-agent"))
    monkeypatch.setattr(installer.os, "geteuid", lambda: 0)
    monkeypatch.setattr(installer, "_find_uv", lambda: "/root/.local/bin/uv")
    monkeypatch.setattr(installer, "_uv_tool_exec_path", lambda uv: str(bin_dir / "lab-agent"))
    monkeypatch.setattr(installer, "SYSTEMD_UNIT_PATH", unit)
    run_calls: list[list[str]] = []
    monkeypatch.setattr(installer, "_run",
                        lambda cmd, env=None: run_calls.append(cmd) or (0, "lab-agent 0.1.0\n"))
    monkeypatch.setattr(installer.os, "system", lambda cmd: 0)

    result = installer.upgrade()

    assert ["/root/.local/bin/uv", "tool", "uninstall", "lab-agent"] in run_calls
    assert result["lab-agent"] == str(bin_dir / "lab-agent")
    text = unit.read_text()
    assert f"ExecStart={bin_dir / 'lab-agent'} run" in text
    # The configured path survives the rewrite.
    assert "Environment=LAB_AGENT_CONFIG=/etc/lab-agent/config.toml" in text


def test_cleanup_uninstalls_both_layouts_and_spares_a_real_file(monkeypatch, tmp_path):
    bin_dir = _redirect_system_dirs(monkeypatch, tmp_path)
    bin_dir.mkdir(parents=True)
    link = bin_dir / "lab-agent"
    monkeypatch.setattr(installer, "SYSTEMD_UNIT_PATH", tmp_path / "lab-agent.service")
    monkeypatch.setattr(installer, "_find_uv", lambda: "/usr/local/bin/uv")
    envs: list[dict | None] = []
    monkeypatch.setattr(installer, "_run", lambda cmd, env=None: envs.append(env) or (0, ""))
    monkeypatch.setattr(installer.os, "system", lambda cmd: 0)

    link.symlink_to(tmp_path / "whatever")
    installer._cleanup_previous_install()
    # Both the system layout (env set) and the legacy per-user one (no env) are uninstalled.
    assert [e is not None for e in envs] == [True, False]
    assert not link.is_symlink() and not link.exists()

    link.write_text("someone else's binary")
    installer._cleanup_previous_install()
    assert link.read_text() == "someone else's binary"


def test_upgrade_without_uv_raises(monkeypatch):
    monkeypatch.setattr(installer.os, "geteuid", lambda: 0)
    monkeypatch.setattr(installer, "_find_uv", lambda: None)
    with pytest.raises(RuntimeError, match="uv"):
        installer.upgrade()


def test_service_status_parses_systemctl(monkeypatch):
    outputs = {("systemctl", "is-active"): "active\n", ("systemctl", "is-enabled"): "enabled\n"}
    monkeypatch.setattr(installer, "_run", lambda cmd, env=None: (0, outputs[(cmd[0], cmd[1])]))
    status = installer.service_status()
    assert status == {"active": "active", "enabled": "enabled"}


def test_repo_spec_pins_ref():
    assert installer._repo_spec() == installer.REPO_SPEC
    assert installer._repo_spec("v1.2.3") == f"{installer.REPO_URL}@v1.2.3#{installer.REPO_SUBDIR}"


def test_install_tool_passes_ref_to_uv(monkeypatch, tmp_path):
    bin_dir = _redirect_system_dirs(monkeypatch, tmp_path)
    monkeypatch.setattr(installer, "_find_uv", lambda: str(bin_dir / "uv"))
    monkeypatch.setattr(installer, "_uv_tool_exec_path", lambda uv: str(bin_dir / "lab-agent"))
    seen: dict[str, list[str]] = {}

    def fake_run(cmd, env=None):
        seen["cmd"] = cmd
        return 0, ""

    monkeypatch.setattr(installer, "_run", fake_run)
    installer._install_tool("v2.0.0")
    assert seen["cmd"][-1] == f"{installer.REPO_URL}@v2.0.0#{installer.REPO_SUBDIR}"
