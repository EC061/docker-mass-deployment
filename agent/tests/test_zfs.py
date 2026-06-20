import pytest

from lab_agent.executors import zfs
from lab_agent.executors.base import CommandResult


class FakeRunner:
    """Records argv and returns canned results keyed by a prefix of the command."""

    def __init__(self):
        self.calls: list[list[str]] = []
        self.responses: dict[str, CommandResult] = {}

    def __call__(self, args, **kwargs):
        argv = [str(a) for a in args]
        self.calls.append(argv)
        key = " ".join(argv[:3])
        for prefix, res in self.responses.items():
            if " ".join(argv).startswith(prefix):
                return res
        return self.responses.get(key, CommandResult(True, argv, 0, "", ""))


@pytest.fixture
def runner(monkeypatch):
    r = FakeRunner()
    monkeypatch.setattr(zfs, "run", r)
    return r


def test_create_dataset_with_quota(runner):
    runner.responses["zfs list -H -o name fast/labs/bio"] = CommandResult(False, [], 1, "", "missing")
    zfs.create_dataset("fast/labs/bio", quota_bytes=2_000_000_000_000)
    assert ["zfs", "create", "-p", "fast/labs/bio"] in runner.calls
    assert ["zfs", "set", "quota=2000000000000", "fast/labs/bio"] in runner.calls


def test_create_dataset_idempotent(runner):
    # Dataset already exists -> no `zfs create`, but quota still applied.
    runner.responses["zfs list -H -o name fast/labs/bio"] = CommandResult(True, [], 0, "fast/labs/bio\n", "")
    zfs.create_dataset("fast/labs/bio", quota_bytes=5)
    assert not any(c[:2] == ["zfs", "create"] for c in runner.calls)
    assert ["zfs", "set", "quota=5", "fast/labs/bio"] in runner.calls


def test_set_quota_none_clears(runner):
    zfs.set_quota("fast/labs/bio", None)
    assert ["zfs", "set", "quota=none", "fast/labs/bio"] in runner.calls


def test_get_usage_parses(runner):
    runner.responses["zfs get -Hp -o value used,quota,available fast/labs/bio"] = CommandResult(
        True, [], 0, "1024\n2000000000000\n1999999998976\n", ""
    )
    u = zfs.get_usage("fast/labs/bio")
    assert u.used_bytes == 1024
    assert u.quota_bytes == 2_000_000_000_000
    assert u.available_bytes == 1_999_999_998_976


def test_get_usage_handles_no_quota(runner):
    runner.responses["zfs get -Hp -o value used,quota,available fast/labs/bio/shared"] = CommandResult(
        True, [], 0, "512\n-\n-\n", ""
    )
    u = zfs.get_usage("fast/labs/bio/shared")
    assert u.used_bytes == 512
    assert u.quota_bytes is None


def test_set_quota_failure_raises(runner):
    runner.responses["zfs set quota=5 bad"] = CommandResult(False, [], 1, "", "dataset does not exist")
    with pytest.raises(zfs.ZfsError):
        zfs.set_quota("bad", 5)


def test_list_usage_parses_tabbed(runner):
    out = "fast/labs/bio\t1024\t2000\t976\nfast/labs/bio/users/alice\t512\t-\t-\n"
    runner.responses["zfs list -Hp -r -o name,used,quota,available fast/labs"] = CommandResult(True, [], 0, out, "")
    rows = zfs.list_usage("fast/labs")
    assert len(rows) == 2
    assert rows[0].dataset == "fast/labs/bio" and rows[0].used_bytes == 1024
    assert rows[1].quota_bytes is None


def test_destroy_skips_when_absent(runner):
    runner.responses["zfs list -H -o name fast/labs/gone"] = CommandResult(False, [], 1, "", "missing")
    zfs.destroy_dataset("fast/labs/gone")
    assert not any(c[:2] == ["zfs", "destroy"] for c in runner.calls)
