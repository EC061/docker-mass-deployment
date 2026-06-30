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
    assert calls == [("slow/labs/bio", {"quota_bytes": 3000})]


def test_smb_refuses_unmounted_fallback(monkeypatch):
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: False)
    with pytest.raises(ColdFsError, match="refusing fallback"):
        coldstore.create_lab(smb_cfg(), "bio", 3000)


def test_smb_uses_flat_lab_root_when_mounted(monkeypatch):
    calls = []
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: True)
    monkeypatch.setattr(coldstore.coldfs, "ensure_dir", calls.append)
    coldstore.create_lab(smb_cfg(), "bio", 3000)
    assert calls == ["/mnt/cold/labs/bio"]
    assert coldstore.lab_mount(smb_cfg(), "bio") == "/mnt/cold/labs/bio"


def test_smb_status_and_usage(monkeypatch):
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: True)
    assert coldstore.cold_status(smb_cfg())["ready"] is True
