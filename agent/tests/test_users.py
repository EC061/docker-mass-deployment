import pytest

from lab_agent.executors import users
from lab_agent.executors.base import CommandResult
from lab_agent.executors.docker import DockerError


class CaptureExec:
    def __init__(self, ok=True):
        self.calls = []
        self.ok = ok

    def __call__(self, name, argv, input_text=None):
        self.calls.append({"name": name, "argv": argv, "input": input_text})
        return CommandResult(self.ok, argv, 0 if self.ok else 1, "", "" if self.ok else "boom")


@pytest.fixture
def cap(monkeypatch):
    c = CaptureExec()
    monkeypatch.setattr(users, "exec_in", c)
    return c


def test_add_user_script_creates_user_and_links(cap):
    users.add_user("lab-bio", "alice", "s3cret")
    script = cap.calls[0]["input"]
    assert "u=alice" in script
    assert "useradd -m -s /bin/bash" in script
    assert "ln -sfn /labusers/fast/" in script
    assert "ln -sfn /labusers/slow/" in script
    assert "umask 027" in script
    # Users are granted sudo + docker-group membership (safe only because lab containers run under
    # the Sysbox runtime, which remaps container-root to an unprivileged host UID).
    assert "usermod -aG sudo,docker" in script
    assert "groupadd docker" in script
    assert "chpasswd" in script
    # Password is in the piped script body, not in argv.
    assert "s3cret" in script
    assert all("s3cret" not in a for a in cap.calls[0]["argv"])


def test_add_user_password_is_shell_quoted(cap):
    users.add_user("lab-bio", "bob", "pa'ss")
    script = cap.calls[0]["input"]
    assert "'pa'\\''ss'" in script


def test_invalid_username_rejected(cap):
    with pytest.raises(DockerError):
        users.add_user("lab-bio", "Bad Name!", "x")
    assert cap.calls == []


def test_remove_user_default_keeps_home(cap):
    users.remove_user("lab-bio", "alice")
    assert "userdel alice" in cap.calls[0]["input"]
    assert "userdel -r" not in cap.calls[0]["input"]


def test_remove_user_delete_home(cap):
    users.remove_user("lab-bio", "alice", delete_home=True)
    assert "userdel -r alice" in cap.calls[0]["input"]


def test_exec_failure_raises(monkeypatch):
    monkeypatch.setattr(users, "exec_in", CaptureExec(ok=False))
    with pytest.raises(DockerError):
        users.add_user("lab-bio", "alice", "x")
