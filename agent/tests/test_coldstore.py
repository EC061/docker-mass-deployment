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


# --- cold_status reporting (Phase 3) --------------------------------------------------------


def test_cold_status_zfs_is_local_and_ready(monkeypatch):
    monkeypatch.setattr(coldstore.zfs, "get_mountpoint", lambda ds: "/slow")
    assert coldstore.cold_status(_zfs_cfg()) == {"backend": "zfs", "mount_path": "/slow", "ready": True}


def test_cold_status_smb_reports_active_mount(monkeypatch):
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda p: p == "/mnt/cold")
    st = coldstore.cold_status(_smb_cfg())
    assert st["backend"] == "smb" and st["mount_path"] == "/mnt/cold" and st["ready"] is True
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda p: False)
    assert coldstore.cold_status(_smb_cfg())["ready"] is False


def test_smb_set_quota_is_noop():
    note = coldstore.set_lab_quota(_smb_cfg(), "bio", 5000)
    # The owner ZFS node enforces the quota; the SMB client does not.
    assert "owner" in note.lower() or "smb" in note.lower()


def test_smb_destroy_lab_guards_root(monkeypatch):
    calls = []
    monkeypatch.setattr(coldstore.coldfs, "remove_tree", lambda p, *, guard: calls.append((p, guard)))
    coldstore.destroy_lab(_smb_cfg(), "bio")
    assert calls == [("/mnt/cold/labs/bio", "/mnt/cold/labs")]


def test_smb_mounts_are_directories():
    cfg = _smb_cfg()
    assert coldstore.shared_mount(cfg, "bio") == "/mnt/cold/labs/bio/shared"
    assert coldstore.users_mount(cfg, "bio") == "/mnt/cold/labs/bio/users"


def test_smb_lab_usage_not_measured_locally():
    # The SMB client doesn't measure cold usage; the owner node reports it.
    u = coldstore.lab_usage(_smb_cfg(), "bio")
    assert u.used_bytes == 0
    assert u.quota_bytes is None
    assert u.available_bytes is None
    assert u.dataset == "/mnt/cold/labs/bio"


def test_smb_list_usage_is_empty():
    # No cold-storage telemetry from the SMB client backend.
    assert coldstore.list_usage(_smb_cfg()) == []
