from pathlib import Path

from lab_agent import maintenance_state as ms
from lab_agent.config import AgentConfig


def _cfg(tmp_path: Path) -> AgentConfig:
    # maintenance_state lives beside the state DB; point both at a temp dir.
    return AgentConfig(controller_url="ws://x", token="t",
                       state_db=str(tmp_path / "state.db"))


def test_missing_file_reads_as_never_patched(tmp_path):
    cfg = _cfg(tmp_path)
    assert ms.last_apt_upgrade(cfg, "bio") is None
    assert ms.all_apt_upgrades(cfg) == {}
    # Never-patched labs are always due.
    assert ms.is_due(cfg, "bio", 604800) is True


def test_record_and_read_back(tmp_path):
    cfg = _cfg(tmp_path)
    ms.record_apt_upgrade(cfg, "bio", when=1_000_000)
    ms.record_apt_upgrade(cfg, "chem", when=2_000_000)
    assert ms.last_apt_upgrade(cfg, "bio") == 1_000_000
    assert ms.all_apt_upgrades(cfg) == {"bio": 1_000_000, "chem": 2_000_000}
    # The file is created beside the state DB.
    assert Path(cfg.maintenance_state).exists()


def test_is_due_respects_interval(tmp_path):
    cfg = _cfg(tmp_path)
    ms.record_apt_upgrade(cfg, "bio", when=1_000_000)
    week_ms = 604800 * 1000
    # Just under a week later -> not due; a week later -> due.
    assert ms.is_due(cfg, "bio", 604800, now=1_000_000 + week_ms - 1) is False
    assert ms.is_due(cfg, "bio", 604800, now=1_000_000 + week_ms) is True


def test_mark_unpatched_makes_lab_due(tmp_path):
    cfg = _cfg(tmp_path)
    ms.record_apt_upgrade(cfg, "bio", when=1_000_000)
    assert ms.is_due(cfg, "bio", 604800, now=1_000_001) is False
    ms.mark_unpatched(cfg, "bio")
    assert ms.last_apt_upgrade(cfg, "bio") == 0
    # Reset to epoch 0, so any "now" past one interval is due.
    assert ms.is_due(cfg, "bio", 604800, now=604800 * 1000 + 1) is True


def test_corrupt_file_reads_as_empty(tmp_path):
    cfg = _cfg(tmp_path)
    Path(cfg.maintenance_state).write_text("{not json")
    assert ms.all_apt_upgrades(cfg) == {}
    # And a subsequent write still succeeds (overwrites the corrupt file).
    ms.record_apt_upgrade(cfg, "bio", when=5)
    assert ms.last_apt_upgrade(cfg, "bio") == 5
