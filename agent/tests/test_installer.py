from pathlib import Path

import pytest

from lab_agent import installer
from lab_agent.config import AgentConfig


def _cfg():
    return AgentConfig(controller_url="wss://ctl:8443", token="secret", node_name="node-1")


def test_resolve_executable_prefers_path_binary(monkeypatch):
    monkeypatch.setattr(installer.shutil, "which", lambda _: "/usr/local/bin/lab-agent")
    assert installer._resolve_executable() == "/usr/local/bin/lab-agent"


def test_resolve_executable_falls_back_to_python_module(monkeypatch):
    monkeypatch.setattr(installer.shutil, "which", lambda _: None)
    monkeypatch.setattr(installer.sys, "executable", "/opt/py/bin/python")
    assert installer._resolve_executable() == "/opt/py/bin/python -m lab_agent.cli"


def test_render_unit_contains_exec_start_and_config(monkeypatch):
    monkeypatch.setattr(installer.shutil, "which", lambda _: "/usr/bin/lab-agent")
    unit = installer.render_unit(Path("/etc/lab-agent/config.toml"))
    assert "ExecStart=/usr/bin/lab-agent run" in unit
    assert "Environment=LAB_AGENT_CONFIG=/etc/lab-agent/config.toml" in unit
    assert "Restart=always" in unit
    assert "User=root" in unit
    assert "WantedBy=multi-user.target" in unit


def test_install_requires_root(monkeypatch, tmp_path):
    monkeypatch.setattr(installer.os, "geteuid", lambda: 1000)
    with pytest.raises(PermissionError):
        installer.install(_cfg(), tmp_path / "config.toml")


def test_install_writes_config_and_unit_and_enables(monkeypatch, tmp_path):
    monkeypatch.setattr(installer.os, "geteuid", lambda: 0)
    monkeypatch.setattr(installer.shutil, "which", lambda _: "/usr/bin/lab-agent")
    monkeypatch.setattr(installer, "STATE_DIR", tmp_path / "state")
    unit_path = tmp_path / "lab-agent.service"
    monkeypatch.setattr(installer, "SYSTEMD_UNIT_PATH", unit_path)
    calls: list[str] = []
    monkeypatch.setattr(installer.os, "system", lambda cmd: calls.append(cmd) or 0)

    config_path = tmp_path / "config.toml"
    result = installer.install(_cfg(), config_path, enable=True)

    assert config_path.exists()
    assert 'controller_url = "wss://ctl:8443"' in config_path.read_text()
    assert (tmp_path / "state").is_dir()
    assert "ExecStart=/usr/bin/lab-agent run" in unit_path.read_text()
    assert result["status"] == "enabled and started"
    assert any("daemon-reload" in c for c in calls)
    assert any("enable --now lab-agent.service" in c for c in calls)


def test_install_no_enable_skips_systemctl(monkeypatch, tmp_path):
    monkeypatch.setattr(installer.os, "geteuid", lambda: 0)
    monkeypatch.setattr(installer.shutil, "which", lambda _: "/usr/bin/lab-agent")
    monkeypatch.setattr(installer, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(installer, "SYSTEMD_UNIT_PATH", tmp_path / "lab-agent.service")
    calls: list[str] = []
    monkeypatch.setattr(installer.os, "system", lambda cmd: calls.append(cmd) or 0)

    result = installer.install(_cfg(), tmp_path / "config.toml", enable=False)
    assert result["status"] == "written (not enabled)"
    assert calls == []
