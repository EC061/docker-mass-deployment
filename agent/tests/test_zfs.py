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
    # A NEW dataset gets its quota (and mountpoint) as -o properties at creation, so it is never
    # even momentarily unlimited or mounted at the inherited path.
    runner.responses["zfs list -H -o name fast/labs/bio"] = CommandResult(False, [], 1, "", "missing")
    zfs.create_dataset("fast/labs/bio", quota_bytes=2_000_000_000_000, mountpoint="/fast/bio")
    assert ["zfs", "create", "-p", "-o", "quota=2000000000000", "-o", "mountpoint=/fast/bio",
            "fast/labs/bio"] in runner.calls
    # No separate `zfs set quota=` window between create and quota.
    assert not any(c[:2] == ["zfs", "set"] for c in runner.calls)


def test_create_dataset_does_not_remount_an_already_correct_mountpoint(runner):
    # Regression: `zfs set mountpoint` unmounts and remounts, which fails with "pool or dataset is
    # busy" once a child dataset is mounted under the tier root. Provisioning the SECOND lab on a
    # multi-pool tier re-asserts the tier root's (already correct) mountpoint, so a blind `zfs set`
    # there broke every lab after the first.
    runner.responses["zfs list -H -o name fast1/labs"] = CommandResult(True, [], 0, "fast1/labs\n", "")
    runner.responses["zfs get -H -o value mountpoint fast1/labs"] = CommandResult(
        True, [], 0, "/mnt/lab-storage/fast1/labs\n", ""
    )
    zfs.create_dataset("fast1/labs", mountpoint="/mnt/lab-storage/fast1/labs")
    assert not any(c[:2] == ["zfs", "set"] and c[2].startswith("mountpoint=") for c in runner.calls)


def test_create_dataset_moves_a_genuinely_different_mountpoint(runner):
    # The converse: a real change must still be applied.
    runner.responses["zfs list -H -o name fast1/labs"] = CommandResult(True, [], 0, "fast1/labs\n", "")
    runner.responses["zfs get -H -o value mountpoint fast1/labs"] = CommandResult(True, [], 0, "/old\n", "")
    zfs.create_dataset("fast1/labs", mountpoint="/mnt/lab-storage/fast1/labs")
    assert ["zfs", "set", "mountpoint=/mnt/lab-storage/fast1/labs", "fast1/labs"] in runner.calls


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


# --- scrub ----------------------------------------------------------------------------------

CLEAN_STATUS = """  pool: fast
 state: ONLINE
  scan: scrub repaired 0B in 00:12:34 with 0 errors on Sun Jun  1 03:12:00 2026
config:
\tNAME        STATE     READ WRITE CKSUM
\tfast        ONLINE       0     0     0

errors: No known data errors
"""

ERROR_STATUS = """  pool: slow
 state: DEGRADED
  scan: scrub repaired 0B in 01:02:03 with 7 errors on Sun Jun  1 03:12:00 2026
config:
\tNAME        STATE     READ WRITE CKSUM
\tslow        DEGRADED     0     0    12

errors: 7 data errors, use '-v' for a list
"""

SCRUBBING_STATUS = """  pool: fast
 state: ONLINE
  scan: scrub in progress since Sun Jun  1 03:00:00 2026
errors: No known data errors
"""


def test_parse_scrub_status_clean():
    st = zfs.parse_scrub_status("fast", CLEAN_STATUS)
    assert st.state == "ONLINE"
    assert st.healthy is True
    assert st.scrubbing is False
    assert st.errors == 0
    assert "0 errors" in (st.last_scrub or "")


def test_parse_scrub_status_errors():
    st = zfs.parse_scrub_status("slow", ERROR_STATUS)
    assert st.healthy is False
    assert st.errors == 7
    assert st.state == "DEGRADED"


def test_parse_scrub_status_in_progress():
    st = zfs.parse_scrub_status("fast", SCRUBBING_STATUS)
    assert st.scrubbing is True
    assert st.healthy is True


def test_start_scrub_runs_command(runner):
    assert zfs.start_scrub("fast") is True
    assert ["zpool", "scrub", "fast"] in runner.calls


def test_start_scrub_tolerates_already_running(runner):
    runner.responses["zpool scrub fast"] = CommandResult(
        False, [], 1, "", "currently scrubbing; use 'zpool scrub -s' to cancel scrub in progress"
    )
    assert zfs.start_scrub("fast") is True


def test_start_scrub_raises_on_real_failure(runner):
    runner.responses["zpool scrub bad"] = CommandResult(False, [], 1, "", "no such pool 'bad'")
    with pytest.raises(zfs.ZfsError):
        zfs.start_scrub("bad")


def test_scrub_status_reports_unknown_on_failure(runner):
    runner.responses["zpool status gone"] = CommandResult(False, [], 1, "", "no such pool")
    st = zfs.scrub_status("gone")
    assert st.healthy is False
    assert st.errors == -1
