"""Old-file scanning.

Walks a dataset's mountpoint once and buckets files whose atime / mtime are older than a threshold,
reporting count + bytes for each, plus the oldest mtime seen. One traversal computes both buckets
(cheaper than two `find` passes). Runs nightly and on demand ("rescan now").

Note: atime numbers are only meaningful when the dataset is not mounted relatime/noatime (see the
host-prep docs in the root README).
"""

from __future__ import annotations

import os
import stat
import time
from dataclasses import asdict, dataclass
from typing import Any

from .config import AgentConfig
from .executors import zfs
from .paths import lab_fast_shared, lab_slow_shared, user_cold, user_scratch


@dataclass
class ScanResult:
    atime_count: int = 0
    atime_bytes: int = 0
    mtime_count: int = 0
    mtime_bytes: int = 0
    oldest: int | None = None  # oldest mtime, epoch ms


def scan_path(path: str, threshold_days: float, *, now: float | None = None) -> ScanResult:
    now = now if now is not None else time.time()
    cutoff = now - threshold_days * 86400
    r = ScanResult()
    for root, _dirs, files in os.walk(path):
        for fname in files:
            fpath = os.path.join(root, fname)
            try:
                st = os.lstat(fpath)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            if st.st_atime < cutoff:
                r.atime_count += 1
                r.atime_bytes += st.st_size
            if st.st_mtime < cutoff:
                r.mtime_count += 1
                r.mtime_bytes += st.st_size
            mtime_ms = int(st.st_mtime * 1000)
            if r.oldest is None or mtime_ms < r.oldest:
                r.oldest = mtime_ms
    return r


def _scan_dataset(dataset: str, threshold_days: float) -> ScanResult | None:
    """Resolve a dataset's mountpoint and scan it; None if the dataset is absent."""
    if not zfs.dataset_exists(dataset):
        return None
    mp = zfs.get_mountpoint(dataset)
    if not mp or mp in ("none", "legacy") or not os.path.isdir(mp):
        return None
    return scan_path(mp, threshold_days)


def scan_lab(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Dispatcher handler for oldfiles.scan.

    params: {lab, users: [username...], threshold_days}
    Returns a list of {scope, username?, dataset, ...counts}.
    """
    lab = params["lab"]
    users = params.get("users", [])
    threshold = float(params.get("threshold_days", 30))

    targets: list[tuple[str, str | None, str]] = [
        ("lab_fast_shared", None, lab_fast_shared(cfg, lab)),
        ("lab_slow_shared", None, lab_slow_shared(cfg, lab)),
    ]
    for u in users:
        targets.append(("user_scratch", u, user_scratch(cfg, lab, u)))
        targets.append(("user_cold", u, user_cold(cfg, lab, u)))

    results = []
    for scope, username, dataset in targets:
        res = _scan_dataset(dataset, threshold)
        if res is None:
            continue
        row = {"scope": scope, "username": username, "dataset": dataset, **asdict(res)}
        results.append(row)
    summary = {"lab": lab, "threshold_days": threshold, "results": results}
    return summary, f"scanned {len(results)} datasets"
