from lab_agent import maintenance
from lab_agent.config import AgentConfig
from lab_agent.executors.zfs import ScrubStatus


def _ok_status(pool):
    return ScrubStatus(pool, "ONLINE", True, False, 0, "none requested", "ok")


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
