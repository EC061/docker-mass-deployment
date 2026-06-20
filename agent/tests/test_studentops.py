from lab_agent import studentops
from lab_agent.config import AgentConfig


def _cfg():
    return AgentConfig(controller_url="ws://x", token="t", fast_pool="fast", slow_pool="slow")


def _patch(monkeypatch):
    created, destroyed, user_calls = [], [], []
    monkeypatch.setattr(
        studentops.zfs, "create_dataset",
        lambda name, *, quota_bytes=None, create_parents=True: created.append((name, quota_bytes)),
    )
    monkeypatch.setattr(
        studentops.zfs, "destroy_dataset",
        lambda name, *, recursive=True: destroyed.append(name),
    )
    monkeypatch.setattr(
        studentops.users, "add_user",
        lambda c, u, p: user_calls.append(("add", c, u, p)),
    )
    monkeypatch.setattr(
        studentops.users, "remove_user",
        lambda c, u, *, delete_home=False: user_calls.append(("remove", c, u, delete_home)),
    )
    return created, destroyed, user_calls


def test_add_student_creates_datasets_and_user(monkeypatch):
    created, _destroyed, calls = _patch(monkeypatch)
    studentops.add_student(_cfg(), {"lab": "bio", "username": "alice", "password": "pw"})
    names = [n for n, _ in created]
    assert "fast/labs/bio/users/alice" in names
    assert "slow/labs/bio/users/alice" in names
    assert ("add", "lab-bio", "alice", "pw") in calls


def test_add_student_applies_sub_quota(monkeypatch):
    created, _d, _c = _patch(monkeypatch)
    studentops.add_student(
        _cfg(), {"lab": "bio", "username": "alice", "password": "pw", "scratch_quota_bytes": 100}
    )
    assert ("fast/labs/bio/users/alice", 100) in created


def test_remove_student_keeps_data_by_default(monkeypatch):
    _c, destroyed, calls = _patch(monkeypatch)
    studentops.remove_student(_cfg(), {"lab": "bio", "username": "alice"})
    assert ("remove", "lab-bio", "alice", False) in calls
    assert destroyed == []


def test_remove_student_deletes_data_when_requested(monkeypatch):
    _c, destroyed, calls = _patch(monkeypatch)
    studentops.remove_student(_cfg(), {"lab": "bio", "username": "alice", "delete_data": True})
    assert ("remove", "lab-bio", "alice", True) in calls
    assert "fast/labs/bio/users/alice" in destroyed
    assert "slow/labs/bio/users/alice" in destroyed
