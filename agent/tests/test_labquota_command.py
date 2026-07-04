import json
import os
import subprocess
import sys
from pathlib import Path

LABQUOTA = Path(__file__).parents[2] / "image" / "labquota"


def run_labquota(tmp_path, snapshot, user):
    (tmp_path / "usage.json").write_text(json.dumps(snapshot), encoding="utf-8")
    env = os.environ | {"LABQUOTA_DIR": str(tmp_path), "USER": user}
    return subprocess.run(
        [sys.executable, str(LABQUOTA)],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )


def snapshot_fixture():
    return {
        "generated_at": 1,
        "usage_scanned_at": 1,
        "node": "node-1",
        "lab": "test1",
        "students": [
            {
                "username": "alice",
                "home": {"used": 351 * 1024**2, "quota": None},
                "cold": {"used": 512, "quota": None},
            },
            {
                "username": "zack",
                "home": {"used": 1024**3, "quota": None},
                "cold": {"used": 768 * 1024**3, "quota": None},
            },
        ],
        "totals": {
            "fast": {"used": 350 * 1024**2, "quota": 2 * 1024**4},
            "cold": {"used": 96 * 1024, "quota": 3 * 1024**4},
            "rootfs": {"used": 57 * 1024**2, "quota": 300 * 1024**3},
            "rootfs_used": 57 * 1024**2,
        },
    }


def test_student_usage_does_not_show_nonexistent_individual_quota(tmp_path):
    result = run_labquota(tmp_path, snapshot_fixture(), "alice")

    student_row = next(line for line in result.stdout.splitlines() if "alice  (you)" in line)
    assert "351.0 MiB" in student_row
    assert "512 B" in student_row
    assert " / —" not in student_row


def test_one_table_me_first_total_last(tmp_path):
    snapshot = snapshot_fixture()
    # zack invokes: he must outrank alice despite sorting after her alphabetically.
    result = run_labquota(tmp_path, snapshot, "zack")

    lines = result.stdout.splitlines()
    order = [i for i, line in enumerate(lines)
             if any(k in line for k in ("zack", "alice", "TOTAL"))]
    labels = [lines[i].split()[0] for i in order]
    assert labels == ["zack", "alice", "TOTAL"]

    total_row = next(line for line in lines if line.lstrip().startswith("TOTAL"))
    assert "350.0 MiB / 2.0 TiB (0%)" in total_row
    assert "96.0 KiB / 3.0 TiB (0%)" in total_row
    # Container (rootfs) usage and quota land in the same table.
    assert "57.0 MiB / 300.0 GiB (0%)" in total_row


def test_student_percentages_are_share_of_total_quota(tmp_path):
    result = run_labquota(tmp_path, snapshot_fixture(), "alice")

    zack_row = next(line for line in result.stdout.splitlines() if "zack" in line)
    # 1 GiB of the 2 TiB total fast quota and 768 GiB of the 3 TiB (3072 GiB) total cold quota.
    assert "1.0 GiB (0%)" in zack_row
    assert "768.0 GiB (25%)" in zack_row


def test_legacy_snapshot_without_rootfs_quota_still_renders(tmp_path):
    snapshot = snapshot_fixture()
    del snapshot["totals"]["rootfs"]
    result = run_labquota(tmp_path, snapshot, "alice")

    total_row = next(line for line in result.stdout.splitlines()
                     if line.lstrip().startswith("TOTAL"))
    assert "57.0 MiB" in total_row
