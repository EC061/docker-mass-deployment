import pytest

from lab_agent import coldstore
from lab_agent.config import AgentConfig
from lab_agent.executors.coldfs import ColdFsError


def zfs_cfg():
    return AgentConfig(controller_url="ws://x", token="t")


def smb_cfg():
    return AgentConfig(controller_url="ws://x", token="t", slow_backend="smb",
                       slow_path="/mnt/cold")


def test_zfs_creates_only_one_lab_dataset(monkeypatch):
    calls = []
    monkeypatch.setattr(coldstore.zfs, "create_dataset", lambda name, **kw: calls.append((name, kw)))
    coldstore.create_lab(zfs_cfg(), "bio", 3000)
    assert calls == [("slow/labs/bio", {
        "quota_bytes": 3000, "mountpoint": "/cold-storage/bio",
    })]


def test_smb_refuses_unmounted_fallback(monkeypatch):
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: False)
    with pytest.raises(ColdFsError, match="refusing fallback"):
        coldstore.create_lab(smb_cfg(), "bio", 3000)


def test_smb_uses_flat_lab_root_when_mounted(monkeypatch):
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: True)
    monkeypatch.setattr(coldstore.os, "lstat", lambda path: object())
    monkeypatch.setattr(coldstore.os.path, "isdir", lambda path: True)
    monkeypatch.setattr(coldstore.os.path, "islink", lambda path: False)
    coldstore.create_lab(smb_cfg(), "bio", 3000)
    assert coldstore.lab_mount(smb_cfg(), "bio") == "/mnt/cold/bio"


def test_smb_requires_owner_created_lab_directory(monkeypatch):
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: True)
    monkeypatch.setattr(coldstore.os, "lstat",
                        lambda path: (_ for _ in ()).throw(FileNotFoundError(path)))
    with pytest.raises(ColdFsError, match="provision the owner first"):
        coldstore.create_lab(smb_cfg(), "bio")


def test_smb_destroy_never_removes_shared_owner_directory(monkeypatch):
    monkeypatch.setattr(coldstore.coldfs, "remove_tree",
                        lambda *a, **k: pytest.fail("SMB client attempted shared deletion"))
    coldstore.destroy_lab(smb_cfg(), "bio")


def test_smb_status_and_usage(monkeypatch):
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: True)
    assert coldstore.cold_status(smb_cfg())["ready"] is True


def test_zfs_status_requires_configured_cold_mount_root(monkeypatch):
    monkeypatch.setattr(coldstore.zfs, "get_mountpoint", lambda ds: "/cold-storage")
    assert coldstore.cold_status(zfs_cfg()) == {
        "backend": "zfs", "mount_path": "/cold-storage", "ready": True,
    }
    monkeypatch.setattr(coldstore.zfs, "get_mountpoint", lambda ds: "/slow/labs")
    assert coldstore.cold_status(zfs_cfg())["ready"] is False


def test_owner_and_smb_container_mount_the_same_lab_directory(monkeypatch):
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: True)
    monkeypatch.setattr(coldstore.zfs, "get_mountpoint",
                        lambda dataset: "/cold-storage/bio")
    owner = zfs_cfg()
    client = AgentConfig(controller_url="ws://x", token="t", slow_backend="smb",
                         slow_path="/cold-storage")
    assert coldstore.lab_mount(owner, "bio") == "/cold-storage/bio"
    assert coldstore.lab_mount(client, "bio") == "/cold-storage/bio"
