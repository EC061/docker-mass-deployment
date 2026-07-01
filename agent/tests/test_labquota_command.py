import json
import os
import subprocess
import sys
from pathlib import Path

LABQUOTA = Path(__file__).parents[2] / "image" / "labquota"


def test_student_usage_does_not_show_nonexistent_individual_quota(tmp_path):
    snapshot = {
        "generated_at": 1,
        "usage_scanned_at": 1,
        "node": "node-1",
        "lab": "test1",
        "students": [
            {
                "username": "alice",
                "home": {"used": 351 * 1024**2, "quota": None},
                "cold": {"used": 512, "quota": None},
            }
        ],
        "totals": {
            "fast": {"used": 350 * 1024**2, "quota": 2 * 1024**4},
            "cold": {"used": 96 * 1024, "quota": 3 * 1024**4},
            "rootfs_used": 57 * 1024**2,
        },
    }
    (tmp_path / "usage.json").write_text(json.dumps(snapshot), encoding="utf-8")
    env = os.environ | {"LABQUOTA_DIR": str(tmp_path), "USER": "alice"}

    result = subprocess.run(
        [sys.executable, str(LABQUOTA)],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )

    student_row = next(line for line in result.stdout.splitlines() if "alice  (you)" in line)
    assert "351.0 MiB" in student_row
    assert "512 B" in student_row
    assert " / —" not in student_row
    assert "home 350.0 MiB / 2.0 TiB (0%)" in result.stdout
