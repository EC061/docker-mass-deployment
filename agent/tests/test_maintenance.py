from lab_agent import maintenance
from lab_agent.config import AgentConfig
from lab_agent.executors.base import CommandResult
from lab_agent.executors.zfs import ScrubStatus


def _ok_status(pool):
    return ScrubStatus(pool, "ONLINE", True, False, 0, "none requested", "ok")


def _cfg():
    return AgentConfig(controller_url="ws://x", token="t")


def test_run_apt_upgrade_runs_update_then_upgrade(monkeypatch):
    calls = []

    def fake_exec(name, argv, *, input_text=None, timeout=120.0):
        calls.append((name, argv, timeout))
        return CommandResult(True, argv, 0, "", "")

    monkeypatch.setattr(maintenance.docker, "container_exists", lambda name: True)
    monkeypatch.setattr(maintenance.docker, "exec_in", fake_exec)
    ok, note = maintenance.run_apt_upgrade(_cfg(), "bio", timeout=1800)
    assert ok is True
    assert "patched lab 'bio'" in note
    assert calls[0][0] == "lab-bio"
    # update first, then a non-interactive upgrade, both with the long timeout.
    assert calls[0][1] == ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "update"]
    assert calls[1][1] == ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "-y",
                           "-o", "Dpkg::Options::=--force-confold", "upgrade"]
    assert calls[0][2] == 1800


def test_run_apt_upgrade_skips_when_container_absent(monkeypatch):
    monkeypatch.setattr(maintenance.docker, "container_exists", lambda name: False)
    ok, note = maintenance.run_apt_upgrade(_cfg(), "bio")
    assert ok is False
    assert "not running" in note


def test_run_apt_upgrade_reports_update_failure(monkeypatch):
    monkeypatch.setattr(maintenance.docker, "container_exists", lambda name: True)
    monkeypatch.setattr(maintenance.docker, "exec_in",
                        lambda name, argv, **k: CommandResult(False, argv, 1, "", "network down"))
    ok, note = maintenance.run_apt_upgrade(_cfg(), "bio")
    assert ok is False
    assert "apt-get update failed" in note


def test_run_scrub_starts_all_zfs_pools(monkeypatch):
    started = []
    monkeypatch.setattr(maintenance.zfs, "start_scrub", lambda p: started.append(p) or True)
    monkeypatch.setattr(maintenance.zfs, "scrub_status", _ok_status)
    cfg = AgentConfig(controller_url="ws://x", token="t", fast_pool="fast", slow_pool="slow")
    result, note = maintenance.run_scrub(cfg, {})
    assert started == ["fast", "slow"]
    assert result["started"] == {"fast": True, "slow": True}
    assert "fast" in note and "slow" in note


def test_run_scrub_skips_smb_cold_storage(monkeypatch):
    started = []
    monkeypatch.setattr(maintenance.zfs, "start_scrub", lambda p: started.append(p) or True)
    monkeypatch.setattr(maintenance.zfs, "scrub_status", _ok_status)
    cfg = AgentConfig(controller_url="ws://x", token="t", slow_backend="smb", slow_path="/mnt/cold")
    _result, _note = maintenance.run_scrub(cfg, {})
    # The SMB slow tier has no pool to scrub.
    assert started == ["fast"]


def test_run_scrub_honours_requested_pools_within_scrubbable(monkeypatch):
    started = []
    monkeypatch.setattr(maintenance.zfs, "start_scrub", lambda p: started.append(p) or True)
    monkeypatch.setattr(maintenance.zfs, "scrub_status", _ok_status)
    cfg = AgentConfig(controller_url="ws://x", token="t", fast_pool="fast", slow_pool="slow")
    # A request for an unknown pool is ignored; only scrubbable pools run.
    maintenance.run_scrub(cfg, {"pools": ["slow", "bogus"]})
    assert started == ["slow"]
