import json

from lab_agent import usagereport
from lab_agent.config import AgentConfig
from lab_agent.executors.zfs import Usage


def cfg(**kw):
    return AgentConfig(controller_url="wss://c", token="t", node_name="node1", **kw)


def test_flat_dataset_parser_ignores_all_descendants():
    assert usagereport._parse_dataset("fast/labs/bio", "fast/labs") == ("bio", None)
    assert usagereport._parse_dataset("fast/labs/bio/users/alice", "fast/labs") is None
    assert usagereport._parse_dataset("fast/labs/bio/shared", "fast/labs") is None


def test_snapshot_uses_container_oriented_names():
    usage = usagereport.ContainerUsage(scanned_at=5, total_used=300,
        per_user={"alice": 120}, per_user_fast={"alice": 40},
        per_user_slow={"alice": 10}, unattributed=180)
    lab = usagereport.LabUsage(fast=Usage("fast/labs/bio", 500, 1000, 500),
                               slow=Usage("slow/labs/bio", 200, 2000, 1800))
    snap = usagereport.build_snapshot(cfg(), "bio", lab, usage, roster=["alice"], now=9)
    assert snap["totals"]["rootfs_used"] == 300
    assert snap["usage_scanned_at"] == 5
    assert snap["students"][0]["home"] == {"used": 40, "quota": None}
    assert "home_used" not in snap["students"][0]


def test_explicit_storage_telemetry(monkeypatch):
    monkeypatch.setattr(usagereport.docker, "container_exists", lambda name: True)
    monkeypatch.setattr(usagereport.docker, "writable_layer_size", lambda name: 42)
    assert usagereport.live_container_storage("bio") == {
        "lab": "bio", "user": None, "tier": "rootfs", "used_bytes": 42,
        "quota_bytes": None, "available_bytes": None,
    }
    usage = usagereport.ContainerUsage(per_user={"alice": 12},
        per_user_fast={"alice": 4}, per_user_slow={"alice": 1})
    rows = usagereport.rootfs_storage("bio", usage) + usagereport.tier_storage("bio", usage)
    assert {(r["tier"], r["user"]) for r in rows} == {
        ("fast", "alice"), ("cold", "alice")}
    assert all("dataset" not in row and "pool" not in row for row in rows)


def test_scan_uses_flat_container_paths(monkeypatch):
    monkeypatch.setattr(usagereport.docker, "container_exists", lambda name: True)
    monkeypatch.setattr(usagereport.docker, "writable_layer_size", lambda name: 100)
    monkeypatch.setattr(usagereport.docker, "du_home", lambda name, user: 20)
    paths = []
    monkeypatch.setattr(usagereport.docker, "du_path",
                        lambda name, path: paths.append(path) or 5)
    result = usagereport.run_container_scan(cfg(), "bio", ["alice"], now=1)
    assert paths == ["/cold-storage/alice"]
    assert result.per_user_fast == {"alice": 20}
    assert result.per_user_slow == {"alice": 5}


def test_refresh_marker_is_inside_user_fast_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(usagereport.zfs, "get_mountpoint", lambda ds: str(tmp_path))
    (tmp_path / "alice").mkdir()
    marker = tmp_path / "alice" / usagereport.REFRESH_MARKER
    marker.write_text("")
    assert usagereport.marker_path(cfg(), "bio", "alice") == str(marker)
    assert usagereport.newest_request(cfg(), "bio", ["alice"]) is not None


def test_labquota_snapshot_directory_is_agent_owned(tmp_path):
    c = cfg(state_db=str(tmp_path / "state.db"))
    usagereport.ensure_labquota_dirs(c, "bio")
    usagereport.publish_snapshot(c, "bio", {"lab": "bio"})
    path = tmp_path / "labquota" / "bio" / usagereport.USAGE_FILE
    assert json.loads(path.read_text()) == {"lab": "bio"}
    assert not str(path).startswith("/fast")
