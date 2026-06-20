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

    def fake_install(cfg, config_path, *, enable):
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
        "--slow-shared",
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
    assert cfg.slow_shared is True
    assert cfg.tls_verify is False
    assert captured["enable"] is False
    assert "status:" in capsys.readouterr().out


def test_install_enables_by_default(monkeypatch):
    import lab_agent.installer as installer

    captured = {}

    def fake_install(cfg, path, *, enable):
        captured["enable"] = enable
        return {}

    monkeypatch.setattr(installer, "install", fake_install)
    cli.main(["install", "--controller", "ws://c", "--token", "t"])
    assert captured["enable"] is True


def _caps(issues):
    fields = dict(
        zfs=True, docker=True, docker_zfs_driver=True, nvidia_runtime=False, nvidia_gpu=False,
        gpu_count=0, fast_pool_present=True, slow_pool_present=True, slow_backend="zfs",
        slow_shared=False, issues=issues,
    )
    return SimpleNamespace(issues=issues, to_dict=lambda: fields)


def test_doctor_returns_zero_when_healthy(monkeypatch, capsys):
    monkeypatch.setattr(cli, "load_config", lambda path: AgentConfig(controller_url="w", token="t",
                                                                     node_name="n1"))
    monkeypatch.setattr(cli, "detect_capabilities", lambda cfg: _caps([]))
    rc = cli.main(["doctor"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "node: n1" in out
    assert "all checks passed" in out
    assert "issues:" not in out


def test_doctor_returns_one_when_issues(monkeypatch, capsys):
    monkeypatch.setattr(cli, "load_config", lambda path: AgentConfig(controller_url="w", token="t"))
    monkeypatch.setattr(cli, "detect_capabilities", lambda cfg: _caps(["zfs command not found"]))
    rc = cli.main(["doctor"])
    out = capsys.readouterr().out
    assert rc == 1
    assert "issues:" in out
    assert "zfs command not found" in out


def test_doctor_synthesizes_config_when_missing(monkeypatch):
    def raise_missing(path):
        raise FileNotFoundError("nope")

    monkeypatch.setattr(cli, "load_config", raise_missing)
    seen = {}

    def fake_detect(cfg):
        seen["cfg"] = cfg
        return _caps([])

    monkeypatch.setattr(cli, "detect_capabilities", fake_detect)
    assert cli.main(["doctor"]) == 0
    # Falls back to a placeholder config rather than crashing.
    assert seen["cfg"].controller_url == "(none)"
