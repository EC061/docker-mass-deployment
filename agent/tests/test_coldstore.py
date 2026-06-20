from lab_agent import coldstore
from lab_agent.config import AgentConfig


def _zfs_cfg():
    return AgentConfig(controller_url="ws://x", token="t", fast_pool="fast", slow_pool="slow")


def _smb_cfg():
    return AgentConfig(
        controller_url="ws://x", token="t", slow_backend="smb", slow_path="/mnt/cold"
    )


# --- ZFS backend delegates to the zfs executor ----------------------------------------------


def test_zfs_create_lab_makes_datasets(monkeypatch):
    created = []
    monkeypatch.setattr(
        coldstore.zfs, "create_dataset",
        lambda name, *, quota_bytes=None, create_parents=True: created.append((name, quota_bytes)),
    )
    coldstore.create_lab(_zfs_cfg(), "bio", 3000)
    assert ("slow/labs/bio", 3000) in created
    assert ("slow/labs/bio/shared", None) in created
    assert ("slow/labs/bio/users", None) in created


def test_zfs_set_quota_delegates(monkeypatch):
    quotas = []
    monkeypatch.setattr(coldstore.zfs, "set_quota", lambda ds, q: quotas.append((ds, q)))
    note = coldstore.set_lab_quota(_zfs_cfg(), "bio", 5000)
    assert ("slow/labs/bio", 5000) in quotas
    assert "5000" in note


# --- SMB backend uses the filesystem and never enforces a quota -----------------------------


def test_smb_create_lab_makes_directories(monkeypatch):
    dirs = []
    monkeypatch.setattr(coldstore.coldfs, "ensure_dir", lambda p: dirs.append(p))
    coldstore.create_lab(_smb_cfg(), "bio", 3000)  # quota ignored on SMB
    assert "/mnt/cold/labs/bio" in dirs
    assert "/mnt/cold/labs/bio/shared" in dirs
    assert "/mnt/cold/labs/bio/users" in dirs


def test_smb_set_quota_is_noop():
    note = coldstore.set_lab_quota(_smb_cfg(), "bio", 5000)
    assert "not enforced" in note.lower()


def test_smb_create_user_makes_directory(monkeypatch):
    dirs = []
    monkeypatch.setattr(coldstore.coldfs, "ensure_dir", lambda p: dirs.append(p))
    coldstore.create_user(_smb_cfg(), "bio", "alice", 100)
    assert "/mnt/cold/labs/bio/users/alice" in dirs


def test_smb_destroy_lab_guards_root(monkeypatch):
    calls = []
    monkeypatch.setattr(coldstore.coldfs, "remove_tree", lambda p, *, guard: calls.append((p, guard)))
    coldstore.destroy_lab(_smb_cfg(), "bio")
    assert calls == [("/mnt/cold/labs/bio", "/mnt/cold/labs")]


def test_smb_mounts_are_directories():
    cfg = _smb_cfg()
    assert coldstore.shared_mount(cfg, "bio") == "/mnt/cold/labs/bio/shared"
    assert coldstore.users_mount(cfg, "bio") == "/mnt/cold/labs/bio/users"


def test_smb_lab_usage_uses_du(monkeypatch):
    monkeypatch.setattr(coldstore.coldfs, "du_bytes", lambda p: 4096)
    monkeypatch.setattr(coldstore.coldfs, "disk_free", lambda p: (10_000, 6_000))
    coldstore._du_cache.clear()
    u = coldstore.lab_usage(_smb_cfg(), "bio")
    assert u.used_bytes == 4096
    assert u.quota_bytes is None
    assert u.available_bytes == 6_000


def test_smb_list_usage_walks_tree(monkeypatch, tmp_path):
    # Build /mnt/cold/labs/bio/users/alice as real directories under tmp_path.
    cfg = AgentConfig(
        controller_url="ws://x", token="t", slow_backend="smb", slow_path=str(tmp_path)
    )
    (tmp_path / "labs" / "bio" / "users" / "alice").mkdir(parents=True)
    monkeypatch.setattr(coldstore.coldfs, "du_bytes", lambda p: 512)
    monkeypatch.setattr(coldstore.coldfs, "disk_free", lambda p: (10_000, 6_000))
    coldstore._du_cache.clear()
    rows = coldstore.list_usage(cfg)
    datasets = {r["dataset"] for r in rows}
    assert str(tmp_path / "labs" / "bio") in datasets
    assert str(tmp_path / "labs" / "bio" / "users" / "alice") in datasets
    assert all(r["pool"] == "slow" and r["quota_bytes"] is None for r in rows)


def test_smb_pool_free_reports_backend(monkeypatch):
    monkeypatch.setattr(coldstore.coldfs, "disk_free", lambda p: (10_000, 6_000))
    pf = coldstore.pool_free(_smb_cfg())
    assert pf is not None
    assert pf["backend"] == "smb"
    assert pf["free"] == 6_000


def test_zfs_pool_free_is_none():
    # ZFS cold storage is reported via zpool list in telemetry, not coldstore.
    assert coldstore.pool_free(_zfs_cfg()) is None


def test_du_cache_avoids_repeat_calls(monkeypatch):
    calls = []
    monkeypatch.setattr(coldstore.coldfs, "du_bytes", lambda p: calls.append(p) or 100)
    coldstore._du_cache.clear()
    assert coldstore._du_cached("/x", now=1000.0) == 100
    assert coldstore._du_cached("/x", now=1010.0) == 100  # within TTL -> cached
    assert len(calls) == 1
