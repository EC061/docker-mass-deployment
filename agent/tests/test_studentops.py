from lab_agent import studentops
from lab_agent.config import AgentConfig


def _cfg():
    return AgentConfig(controller_url="ws://x", token="t", fast_pool="fast", slow_pool="slow")


def _patch(monkeypatch):
    """Capture user add/remove calls. The new storage model has no per-student datasets, so
    studentops only drives the in-container user executor."""
    user_calls = []
    monkeypatch.setattr(studentops.users, "add_user",
                        lambda c, u, p: user_calls.append(("add", c, u, p)))
    monkeypatch.setattr(studentops.users, "remove_user",
                        lambda c, u, *, delete_fast=False, delete_cold=False: user_calls.append(("remove", c, u, delete_fast, delete_cold)))
    return user_calls


def test_add_student_only_creates_the_user(monkeypatch):
    calls = _patch(monkeypatch)
    studentops.add_student(_cfg(), {"lab": "bio", "username": "alice", "password": "pw"})
    assert ("add", "lab-bio", "alice", "pw") in calls


def test_add_student_ignores_legacy_quota_params(monkeypatch):
    # scratch_quota_bytes / cold_quota_bytes are no longer honored (lab quota only); passing them is
    # a no-op beyond creating the user.
    calls = _patch(monkeypatch)
    result, _msg = studentops.add_student(
        _cfg(),
        {"lab": "bio", "username": "alice", "password": "pw", "scratch_quota_bytes": 100},
    )
    assert result == {"lab": "bio", "username": "alice"}
    assert ("add", "lab-bio", "alice", "pw") in calls


def test_remove_student_keeps_data_by_default(monkeypatch):
    calls = _patch(monkeypatch)
    studentops.remove_student(_cfg(), {"lab": "bio", "username": "alice"})
    assert ("remove", "lab-bio", "alice", False, False) in calls


def test_remove_student_deletes_fast_and_cold_for_a_local_zfs_node(monkeypatch):
    # On a standalone / owner (local-ZFS) node delete_data wipes both fast and cold (default).
    calls = _patch(monkeypatch)
    studentops.remove_student(_cfg(), {"lab": "bio", "username": "alice", "delete_data": True})
    assert ("remove", "lab-bio", "alice", True, True) in calls


def test_remove_student_on_smb_client_never_deletes_cold(monkeypatch):
    # The controller sends delete_cold=False to an SMB client so the owner's shared cold is untouched.
    calls = _patch(monkeypatch)
    studentops.remove_student(
        _cfg(), {"lab": "bio", "username": "alice", "delete_data": True, "delete_cold": False}
    )
    assert ("remove", "lab-bio", "alice", True, False) in calls
