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
                        lambda c, u, *, delete_home=False: user_calls.append(("remove", c, u, delete_home)))
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
    assert ("remove", "lab-bio", "alice", False) in calls


def test_remove_student_deletes_data_when_requested(monkeypatch):
    # delete_data is forwarded to remove_user as delete_home; the in-container script wipes the
    # /labusers subdirs (no host-side dataset destroy).
    calls = _patch(monkeypatch)
    studentops.remove_student(_cfg(), {"lab": "bio", "username": "alice", "delete_data": True})
    assert ("remove", "lab-bio", "alice", True) in calls
