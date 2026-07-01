import pytest

from lab_agent.executors import users
from lab_agent.executors.base import CommandResult
from lab_agent.executors.docker import DockerError


class Capture:
    def __init__(self, ok=True):
        self.calls = []
        self.ok = ok

    def __call__(self, name, argv, input_text=None, **kwargs):
        self.calls.append((name, argv, input_text))
        return CommandResult(self.ok, argv, 0 if self.ok else 1, "", "" if self.ok else "boom")


def test_add_user_exact_ids_sudo_and_flat_links(monkeypatch):
    cap = Capture()
    monkeypatch.setattr(users, "exec_in", cap)
    users.add_user("lab-bio", "alice", "secret", 10042, 10042)
    script = cap.calls[0][2]
    assert "groupadd -g 10042" in script
    assert 'useradd -M -d /home/"$u" -u 10042 -g 10042' in script
    assert "usermod -aG sudo" in script
    assert "PASSWD: ALL" in script
    assert "NOPASSWD" not in script
    assert "chmod 0440 /etc/sudoers.d/zz-lab-agent" in script
    assert '/cold-storage/"$u"' in script
    assert '/fast/"$u"' not in script and '/cold/"$u"' not in script
    assert "docker" not in script
    assert '/home/"$u"/.npmrc' in script
    assert "prefix=/home/%s/.local" in script
    assert '/home/"$u"/.local/bin' in script
    assert '/home/"$u"/.codex' not in script
    assert "use_legacy_landlock" not in script


def test_uid_and_username_validation(monkeypatch):
    cap = Capture()
    monkeypatch.setattr(users, "exec_in", cap)
    for uid, gid in ((9999, 9999), (60000, 60000), (10000, 10001)):
        with pytest.raises(DockerError):
            users.add_user("lab-bio", "alice", "x", uid, gid)
    with pytest.raises(DockerError):
        users.add_user("lab-bio", "Bad Name", "x", 10000, 10000)
    assert cap.calls == []


def test_remove_user_only_removes_account(monkeypatch):
    cap = Capture()
    monkeypatch.setattr(users, "exec_in", cap)
    users.remove_user("lab-bio", "alice")
    script = cap.calls[0][2]
    assert "userdel alice" in script
    assert "userdel -r" not in script
    assert "/fast" not in script and "/cold" not in script
