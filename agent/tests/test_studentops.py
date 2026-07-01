import pytest

from lab_agent import studentops
from lab_agent.config import AgentConfig
from lab_agent.executors.coldfs import ColdFsError


def cfg():
    return AgentConfig(controller_url="ws://x", token="t", userns_start=231072)


def patch_storage(monkeypatch):
    dirs = []
    removed = []
    users = []
    monkeypatch.setattr(studentops.zfs, "get_mountpoint", lambda ds: "/fast/bio")
    monkeypatch.setattr(studentops.coldstore, "lab_mount", lambda c, lab: "/cold/bio")
    monkeypatch.setattr(studentops.coldfs, "ensure_owned_dir",
                        lambda path, uid, gid: dirs.append((path, uid, gid)))
    monkeypatch.setattr(studentops.coldfs, "remove_child",
                        lambda root, name: removed.append((root, name)))
    monkeypatch.setattr(studentops.users, "add_user",
                        lambda container, user, password, uid, gid:
                        users.append(("add", container, user, uid, gid)))
    monkeypatch.setattr(studentops.users, "remove_user",
                        lambda container, user: users.append(("remove", container, user)))
    return dirs, removed, users


def test_add_student_uses_native_host_ownership(monkeypatch):
    dirs, _, calls = patch_storage(monkeypatch)
    result, _ = studentops.add_student(cfg(), {
        "lab": "bio", "username": "alice", "password": "pw", "uid": 10042, "gid": 10042,
    })
    assert result["uid"] == 10042
    assert dirs == [("/fast/bio/alice", 10042, 10042),
                    ("/cold/bio/alice", 10042, 10042)]
    assert calls == [("add", "lab-bio", "alice", 10042, 10042)]


def test_remove_data_is_host_side_and_cold_is_independent(monkeypatch):
    _, removed, calls = patch_storage(monkeypatch)
    studentops.remove_student(cfg(), {
        "lab": "bio", "username": "alice", "delete_data": True, "delete_cold": False,
    })
    assert calls == [("remove", "lab-bio", "alice")]
    assert removed == [("/fast/bio", "alice")]


def test_cold_cleanup_is_owner_only(monkeypatch):
    _, removed, _ = patch_storage(monkeypatch)
    result, _ = studentops.delete_cold_student(cfg(), {"lab": "bio", "username": "alice"})
    assert result["cold_deleted"] is True
    assert removed == [("/cold/bio", "alice")]

    client = AgentConfig(controller_url="ws://x", token="t", slow_backend="smb")
    with pytest.raises(ColdFsError, match="may not delete"):
        studentops.delete_cold_student(client, {"lab": "bio", "username": "alice"})
