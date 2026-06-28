import os

import pytest

from lab_agent import usagereport
from lab_agent.config import AgentConfig
from lab_agent.executors import zfs
from lab_agent.executors.zfs import Usage


def cfg(**kw):
    return AgentConfig(controller_url="wss://c", token="t", node_name="node1", **kw)


def U(dataset, used, quota=None, avail=None):
    return Usage(dataset, used, quota, avail)


# --------------------------------------------------------------------------- dataset parsing


def test_parse_dataset_levels():
    assert usagereport._parse_dataset("fast/labs/bio", "fast/labs") == ("bio", None)
    assert usagereport._parse_dataset("fast/labs/bio/users/alice", "fast/labs") == ("bio", "alice")
    # shared / users-parent / root rows are ignored
    assert usagereport._parse_dataset("fast/labs/bio/shared", "fast/labs") is None
    assert usagereport._parse_dataset("fast/labs/bio/users", "fast/labs") is None
    assert usagereport._parse_dataset("fast/labs", "fast/labs") is None
    assert usagereport._parse_dataset("other/x", "fast/labs") is None


def test_collect_zfs_usage_groups_by_lab_and_user(monkeypatch):
    fast_rows = [
        U("fast/labs", 0),
        U("fast/labs/bio", 500, 1000),
        U("fast/labs/bio/shared", 100),
        U("fast/labs/bio/users", 0),
        U("fast/labs/bio/users/alice", 40, 100),
        U("fast/labs/bio/users/bob", 60, 100),
    ]
    slow_rows = [
        U("slow/labs/bio", 200, 2000),
        U("slow/labs/bio/users/alice", 10, 50),
    ]

    def fake_list_usage(root):
        return fast_rows if root == "fast/labs" else slow_rows

    monkeypatch.setattr(zfs, "list_usage", fake_list_usage)
    grouped = usagereport.collect_zfs_usage(cfg())
    assert set(grouped) == {"bio"}
    bio = grouped["bio"]
    assert bio.fast.used_bytes == 500 and bio.slow.used_bytes == 200
    assert set(bio.users) == {"alice", "bob"}
    assert bio.users["alice"]["fast"].used_bytes == 40
    assert bio.users["alice"]["slow"].used_bytes == 10
    assert "slow" not in bio.users["bob"]  # bob has no cold dataset row


def test_collect_zfs_usage_skips_slow_on_smb(monkeypatch):
    monkeypatch.setattr(zfs, "list_usage", lambda root: [U("fast/labs/bio/users/alice", 5, 10)])
    grouped = usagereport.collect_zfs_usage(cfg(slow_backend="smb"))
    assert grouped["bio"].slow is None
    assert grouped["bio"].users["alice"].get("slow") is None


# --------------------------------------------------------------------------- snapshot building


def test_build_snapshot_shape():
    lab_usage = usagereport.LabUsage(
        fast=U("fast/labs/bio", 500, 1000),
        slow=U("slow/labs/bio", 200, 2000),
        users={
            "alice": {"fast": U("a", 40, 100), "slow": U("a", 10, 50)},
            "bob": {"fast": U("b", 60, 100)},
        },
    )
    docker_usage = usagereport.DockerUsage(
        scanned_at=111, status="idle", total_used=300,
        per_user={"alice": 120, "bob": 80}, unattributed=100,
    )
    snap = usagereport.build_snapshot(cfg(), "bio", lab_usage, docker_usage, now=999)
    assert snap["lab"] == "bio" and snap["node"] == "node1" and snap["generated_at"] == 999
    assert snap["totals"]["fast"] == {"used": 500, "quota": 1000}
    assert snap["totals"]["docker_used"] == 300
    assert snap["docker_scanned_at"] == 111 and snap["docker_unattributed"] == 100
    alice = next(s for s in snap["students"] if s["username"] == "alice")
    assert alice["scratch"] == {"used": 40, "quota": 100}
    assert alice["cold"] == {"used": 10, "quota": 50}
    assert alice["docker_home_used"] == 120
    bob = next(s for s in snap["students"] if s["username"] == "bob")
    assert bob["cold"] is None  # no cold dataset
    assert bob["docker_home_used"] == 80


def test_build_snapshot_lists_roster_with_no_usage():
    """A provisioned student must appear even before any ZFS/docker usage exists for them."""
    snap = usagereport.build_snapshot(
        cfg(), "bio", usagereport.LabUsage(), usagereport.DockerUsage(),
        roster=["carol", "dave"], now=1,
    )
    assert [s["username"] for s in snap["students"]] == ["carol", "dave"]
    carol = snap["students"][0]
    assert carol["scratch"] is None and carol["cold"] is None and carol["docker_home_used"] is None


def test_list_lab_students_from_fast_users_mount(tmp_path, monkeypatch):
    monkeypatch.setattr(usagereport.zfs, "get_mountpoint", lambda ds: str(tmp_path))
    (tmp_path / "alice").mkdir()
    (tmp_path / "bob").mkdir()
    (tmp_path / usagereport.LABQUOTA_DIRNAME).mkdir()  # root-owned, must be skipped
    (tmp_path / "not a user").mkdir()  # invalid username, skipped
    assert usagereport.list_lab_students(cfg(), "bio") == ["alice", "bob"]


def test_list_lab_students_missing_mount(monkeypatch):
    monkeypatch.setattr(usagereport.zfs, "get_mountpoint", lambda ds: "/nonexistent/path")
    assert usagereport.list_lab_students(cfg(), "bio") == []


def test_docker_datasets_telemetry_rows():
    usage = usagereport.DockerUsage(total_used=300, per_user={"alice": 120})
    rows = usagereport.docker_datasets("bio", usage)
    assert {"pool": "docker", "dataset": "docker/labs/bio", "used_bytes": 300, "quota_bytes": None} in rows
    assert {"pool": "docker", "dataset": "docker/labs/bio/users/alice", "used_bytes": 120,
            "quota_bytes": None} in rows


def test_docker_datasets_omits_total_when_unknown():
    rows = usagereport.docker_datasets("bio", usagereport.DockerUsage(per_user={"alice": 120}))
    assert all(r["dataset"] != "docker/labs/bio" for r in rows)


# --------------------------------------------------------------------------- request dir + scan


def test_marker_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(usagereport.zfs, "get_mountpoint", lambda ds: str(tmp_path))
    c = cfg()
    users = ["alice", "bob"]
    (tmp_path / "alice").mkdir()
    assert usagereport.newest_request(c, "bio", users) is None
    # alice touches her marker inside her own scratch dataset (contents are never read).
    (tmp_path / "alice" / usagereport.REFRESH_MARKER).write_text("")
    assert usagereport.newest_request(c, "bio", users) is not None
    usagereport.clear_requests(c, "bio", users)
    assert usagereport.newest_request(c, "bio", users) is None


def test_marker_ignores_symlink_and_directory(tmp_path, monkeypatch):
    """A symlink or directory planted in place of the marker must not count as a request and must
    never make the agent follow a link."""
    monkeypatch.setattr(usagereport.zfs, "get_mountpoint", lambda ds: str(tmp_path))
    c = cfg()
    (tmp_path / "alice").mkdir()
    (tmp_path / "bob").mkdir()
    # alice symlinks her marker at a sensitive target; bob makes his a directory.
    secret = tmp_path / "secret"
    secret.write_text("do-not-read")
    os.symlink(secret, tmp_path / "alice" / usagereport.REFRESH_MARKER)
    (tmp_path / "bob" / usagereport.REFRESH_MARKER).mkdir()
    assert usagereport.newest_request(c, "bio", ["alice", "bob"]) is None
    # Clearing removes only the symlink itself, never its target.
    usagereport.clear_requests(c, "bio", ["alice", "bob"])
    assert secret.exists()


def test_atomic_write_keeps_old_file_on_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(usagereport.zfs, "get_mountpoint", lambda ds: str(tmp_path))
    c = cfg()
    usagereport.ensure_labquota_dirs(c, "bio")
    usagereport.publish_snapshot(c, "bio", {"lab": "bio", "v": 1})
    # Simulate the write failing (e.g. lab quota full) mid-serialization.
    def boom(*a, **k):
        raise OSError("No space left on device")

    monkeypatch.setattr(usagereport.json, "dump", boom)
    with pytest.raises(OSError):
        usagereport.publish_snapshot(c, "bio", {"lab": "bio", "v": 2})
    base = tmp_path / usagereport.LABQUOTA_DIRNAME
    # The previous good snapshot survives and no stray .tmp is left behind.
    import json as _json
    assert _json.loads((base / usagereport.USAGE_FILE).read_text())["v"] == 1
    assert not (base / f"{usagereport.USAGE_FILE}.tmp").exists()


def test_publish_and_status_write(tmp_path, monkeypatch):
    monkeypatch.setattr(usagereport.zfs, "get_mountpoint", lambda ds: str(tmp_path))
    c = cfg()
    usagereport.ensure_labquota_dirs(c, "bio")
    usagereport.publish_snapshot(c, "bio", {"lab": "bio", "hello": 1})
    usagereport.write_status(c, "bio", {"status": "running", "done": 1, "total": 3})
    base = tmp_path / usagereport.LABQUOTA_DIRNAME
    assert (base / usagereport.USAGE_FILE).exists()
    assert (base / usagereport.STATUS_FILE).exists()


def test_run_docker_scan_collects_per_home(monkeypatch):
    monkeypatch.setattr(usagereport.docker, "container_exists", lambda name: True)
    monkeypatch.setattr(usagereport.docker, "writable_layer_size", lambda name: 1000)
    monkeypatch.setattr(usagereport.docker, "du_home", lambda name, u: {"alice": 600, "bob": 300}[u])
    seen = []
    usage = usagereport.run_docker_scan(
        cfg(), "bio", ["alice", "bob"], progress=lambda d, t, c: seen.append((d, t, c)), now=42
    )
    assert usage.total_used == 1000
    assert usage.per_user == {"alice": 600, "bob": 300}
    assert usage.unattributed == 100  # 1000 - 900
    assert usage.scanned_at == 42 and usage.status == "idle"
    assert seen == [(0, 2, "alice"), (1, 2, "bob")]


def test_run_docker_scan_no_container(monkeypatch):
    monkeypatch.setattr(usagereport.docker, "container_exists", lambda name: False)
    usage = usagereport.run_docker_scan(cfg(), "bio", ["alice"], now=42)
    assert usage.total_used is None and usage.per_user == {} and usage.scanned_at == 42
