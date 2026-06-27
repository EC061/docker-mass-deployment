import os
import time
from pathlib import Path

from lab_agent import scan


def test_scan_path_buckets_old_files(tmp_path: Path):
    now = time.time()
    old = now - 40 * 86400  # 40 days ago
    recent = now - 5 * 86400  # 5 days ago

    old_file = tmp_path / "old.bin"
    old_file.write_bytes(b"x" * 100)
    os.utime(old_file, (old, old))

    recent_file = tmp_path / "recent.bin"
    recent_file.write_bytes(b"y" * 50)
    os.utime(recent_file, (recent, recent))

    res = scan.scan_path(str(tmp_path), threshold_days=30, now=now)
    assert res.atime_count == 1
    assert res.atime_bytes == 100
    assert res.mtime_count == 1
    assert res.mtime_bytes == 100
    assert res.oldest is not None


def test_scan_path_recurses(tmp_path: Path):
    now = time.time()
    old = now - 100 * 86400
    sub = tmp_path / "a" / "b"
    sub.mkdir(parents=True)
    f = sub / "deep.bin"
    f.write_bytes(b"z" * 10)
    os.utime(f, (old, old))

    res = scan.scan_path(str(tmp_path), threshold_days=30, now=now)
    assert res.mtime_count == 1
    assert res.mtime_bytes == 10


def test_scan_lab_resolves_mountpoints(tmp_path: Path, monkeypatch):
    from lab_agent.config import AgentConfig

    cfg = AgentConfig(controller_url="ws://x", token="t", fast_pool="fast", slow_pool="slow")

    # The fast `users` dataset holds every student as a plain subdir (no per-student datasets), so
    # the scan resolves the users mountpoint and walks <users_mp>/<username>.
    users_mp = tmp_path / "users"
    alice_dir = users_mp / "alice"
    alice_dir.mkdir(parents=True)
    f = alice_dir / "old.bin"
    f.write_bytes(b"x" * 200)
    old = time.time() - 90 * 86400
    os.utime(f, (old, old))

    def dataset_exists(ds):
        return ds == "fast/labs/bio/users"

    def get_mountpoint(ds):
        return str(users_mp)

    monkeypatch.setattr(scan.zfs, "dataset_exists", dataset_exists)
    monkeypatch.setattr(scan.zfs, "get_mountpoint", get_mountpoint)

    result, _logs = scan.scan_lab(cfg, {"lab": "bio", "users": ["alice"], "threshold_days": 30})
    assert result["lab"] == "bio"
    assert len(result["results"]) == 1
    row = result["results"][0]
    assert row["scope"] == "user_scratch"
    assert row["username"] == "alice"
    assert row["mtime_count"] == 1
    assert row["mtime_bytes"] == 200
