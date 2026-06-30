from types import SimpleNamespace

import pytest

from lab_agent import cli
from lab_agent.config import AgentConfig


def test_build_parser_registers_subcommands():
    parser = cli.build_parser()
    args = parser.parse_args(["doctor"])
    assert args.command == "doctor"
    assert args.func is cli._cmd_doctor


def test_no_subcommand_exits():
    with pytest.raises(SystemExit):
        cli.main([])


def test_run_loads_config_and_starts_agent(monkeypatch):
    import lab_agent.client as client

    cfg = AgentConfig(controller_url="ws://x", token="t")
    monkeypatch.setattr(cli, "load_config", lambda path: cfg)
    started = {}
    monkeypatch.setattr(client, "run_agent", lambda c: started.setdefault("cfg", c))
    assert cli.main(["run"]) == 0
    assert started["cfg"] is cfg


def test_install_builds_config_from_flags_and_calls_installer(monkeypatch, capsys):
    import lab_agent.installer as installer

    captured = {}

    def fake_install(cfg, config_path, *, enable, ref=None):
        captured["cfg"] = cfg
        captured["enable"] = enable
        return {"config": str(config_path), "status": "written (not enabled)"}

    monkeypatch.setattr(installer, "install", fake_install)
    rc = cli.main([
        "install",
        "--controller", "wss://ctl:8443",
        "--token", "secret",
        "--node-name", "node-7",
        "--slow-backend", "smb",
        "--slow-path", "/mnt/cold",
        "--no-verify-tls",
        "--no-enable",
    ])
    assert rc == 0
    cfg = captured["cfg"]
    assert cfg.controller_url == "wss://ctl:8443"
    assert cfg.token == "secret"
    assert cfg.node_name == "node-7"
    assert cfg.slow_backend == "smb"
    assert cfg.slow_path == "/mnt/cold"
    assert cfg.tls_verify is False
    assert captured["enable"] is False
    assert "status:" in capsys.readouterr().out


def test_install_enables_by_default(monkeypatch):
    import lab_agent.installer as installer

    captured = {}

    def fake_install(cfg, path, *, enable, ref=None):
        captured["enable"] = enable
        return {}

    monkeypatch.setattr(installer, "install", fake_install)
    cli.main(["install", "--controller", "ws://c", "--token", "t"])
    assert captured["enable"] is True


def test_install_allows_no_controller_or_token(monkeypatch, capsys):
    """The bootstrap command takes no flags: controller_url/token are edited in the config after."""
    import lab_agent.installer as installer

    captured = {}

    def fake_install(cfg, path, *, enable, ref=None):
        captured["cfg"] = cfg
        return {"status": "installed; enabled on boot but NOT started"}

    monkeypatch.setattr(installer, "install", fake_install)
    rc = cli.main(["install"])
    assert rc == 0
    assert captured["cfg"].controller_url == ""
    assert captured["cfg"].token == ""
    out = capsys.readouterr().out
    assert "Next steps" in out and "lab-agent start" in out


def test_install_failure_returns_one(monkeypatch, capsys):
    import lab_agent.installer as installer

    def boom(cfg, path, *, enable, ref=None):
        raise PermissionError("must run as root")

    monkeypatch.setattr(installer, "install", boom)
    assert cli.main(["install"]) == 1
    assert "install failed" in capsys.readouterr().err


def test_start_stop_upgrade_dispatch(monkeypatch, capsys):
    import lab_agent.installer as installer

    events = []
    monkeypatch.setattr(installer, "start_service", lambda: events.append("start"))
    monkeypatch.setattr(installer, "stop_service", lambda: events.append("stop"))
    monkeypatch.setattr(installer, "upgrade", lambda ref=None: {"version": "lab-agent 0.1.0"})
    assert cli.main(["start"]) == 0
    assert cli.main(["stop"]) == 0
    assert cli.main(["upgrade"]) == 0
    assert events == ["start", "stop"]
    assert "lab-agent 0.1.0" in capsys.readouterr().out


def test_start_reports_failure(monkeypatch, capsys):
    import lab_agent.installer as installer

    def boom():
        raise RuntimeError("failed to start")

    monkeypatch.setattr(installer, "start_service", boom)
    assert cli.main(["start"]) == 1
    assert "start failed" in capsys.readouterr().err


def test_edit_config_opens_editor(monkeypatch, tmp_path):
    config_path = tmp_path / "config.toml"
    config_path.write_text("[agent]\n")
    monkeypatch.setenv("EDITOR", "true")  # a no-op "editor"
    called = {}

    def fake_call(argv):
        called["argv"] = argv
        return 0

    monkeypatch.setattr(cli.subprocess, "call", fake_call)
    rc = cli.main(["--config", str(config_path), "edit-config"])
    assert rc == 0
    assert called["argv"] == ["true", str(config_path)]


def test_edit_config_missing_file(monkeypatch, tmp_path, capsys):
    rc = cli.main(["--config", str(tmp_path / "nope.toml"), "edit-config"])
    assert rc == 1
    assert "run `lab-agent install`" in capsys.readouterr().err


def test_set_token_writes_config_and_restarts(monkeypatch, tmp_path):
    from lab_agent.config import render_config

    config_path = tmp_path / "config.toml"
    config_path.write_text(render_config(AgentConfig(controller_url="wss://ctl:8443", token="old")))

    calls = {}
    monkeypatch.setattr("os.system", lambda cmd: calls.__setitem__("cmd", cmd) or 0)

    rc = cli.main(["--config", str(config_path), "set-token", "new-token-value"])
    assert rc == 0
    assert 'token = "new-token-value"' in config_path.read_text()
    assert "restart" in calls["cmd"] and "lab-agent" in calls["cmd"]


def test_set_token_no_restart(monkeypatch, tmp_path, capsys):
    from lab_agent.config import render_config

    config_path = tmp_path / "config.toml"
    config_path.write_text(render_config(AgentConfig(controller_url="wss://ctl:8443", token="old")))

    monkeypatch.setattr("os.system", lambda cmd: (_ for _ in ()).throw(AssertionError("should not restart")))
    rc = cli.main(["--config", str(config_path), "set-token", "new-token", "--no-restart"])
    assert rc == 0
    assert 'token = "new-token"' in config_path.read_text()
    assert "restart skipped" in capsys.readouterr().out


def _caps(issues):
    issue_rows = [SimpleNamespace(severity="critical", code="test", message=i) for i in issues]
    fields = {"runtime": {"docker_ok": True}, "nvidia": {"gpu_count": 0},
              "storage": {"zfs_ok": True}, "health": {"status": "healthy", "issues": []}}
    return SimpleNamespace(health=SimpleNamespace(issues=issue_rows), to_dict=lambda: fields)


def _stub_status(monkeypatch):
    import lab_agent.installer as installer

    monkeypatch.setattr(installer, "service_status",
                        lambda: {"active": "inactive", "enabled": "enabled"})


def test_doctor_returns_zero_when_healthy(monkeypatch, capsys):
    _stub_status(monkeypatch)
    monkeypatch.setattr(cli, "load_config", lambda path: AgentConfig(controller_url="w", token="t",
                                                                     node_name="n1"))
    monkeypatch.setattr(cli, "detect_capabilities", lambda cfg, **kwargs: _caps([]))
    rc = cli.main(["doctor"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "node: n1" in out
    assert "service: inactive (enabled)" in out
    assert "all checks passed" in out
    assert "issues:" not in out


def test_doctor_returns_one_when_issues(monkeypatch, capsys):
    _stub_status(monkeypatch)
    monkeypatch.setattr(cli, "load_config", lambda path: AgentConfig(controller_url="w", token="t"))
    monkeypatch.setattr(cli, "detect_capabilities", lambda cfg, **kwargs: _caps(["zfs command not found"]))
    rc = cli.main(["doctor"])
    out = capsys.readouterr().out
    assert rc == 1
    assert "issues:" in out
    assert "zfs command not found" in out


def test_doctor_synthesizes_config_when_missing(monkeypatch):
    _stub_status(monkeypatch)
    def raise_missing(path):
        raise FileNotFoundError("nope")

    monkeypatch.setattr(cli, "load_config", raise_missing)
    seen = {}

    def fake_detect(cfg, **kwargs):
        seen["cfg"] = cfg
        return _caps([])

    monkeypatch.setattr(cli, "detect_capabilities", fake_detect)
    assert cli.main(["doctor"]) == 0
    # Falls back to a placeholder config rather than crashing.
    assert seen["cfg"].controller_url == "(none)"
