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

from . import coldstore
from .config import AgentConfig
from .executors import zfs
from .paths import lab_fast_shared, lab_fast_users


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


def _zfs_dir(dataset: str) -> str | None:
    """Resolve a ZFS dataset's mountpoint to an existing directory, or None if absent."""
    if not zfs.dataset_exists(dataset):
        return None
    mp = zfs.get_mountpoint(dataset)
    if not mp or mp in ("none", "legacy") or not os.path.isdir(mp):
        return None
    return mp


def _user_subdir(parent_mp: str | None, user: str) -> str | None:
    """A student's directory is a plain subdir of the lab's `users` dataset mountpoint (there are no
    per-student datasets). Returns the subdir if it exists, else None."""
    if parent_mp is None:
        return None
    d = os.path.join(parent_mp, user)
    return d if os.path.isdir(d) else None


def scan_lab(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Dispatcher handler for oldfiles.scan.

    params: {lab, users: [username...], threshold_days}
    Returns a list of {scope, username?, dataset, ...counts}.
    """
    lab = params["lab"]
    users = params.get("users", [])
    threshold = float(params.get("threshold_days", 30))

    # Each target resolves to a directory to walk. Shared data is its own ZFS dataset (or SMB dir);
    # per-student data is a subdir of the lab's single fast/slow `users` dataset (no per-student
    # datasets), so resolve the users mountpoint once and join each username under it.
    targets: list[tuple[str, str | None, str | None]] = [
        ("lab_fast_shared", None, _zfs_dir(lab_fast_shared(cfg, lab))),
        ("lab_slow_shared", None, coldstore.shared_scan_dir(cfg, lab)),
    ]
    fast_users_mp = _zfs_dir(lab_fast_users(cfg, lab))
    for u in users:
        targets.append(("user_scratch", u, _user_subdir(fast_users_mp, u)))
        targets.append(("user_cold", u, coldstore.user_scan_dir(cfg, lab, u)))

    results = []
    for scope, username, directory in targets:
        if directory is None:
            continue
        res = scan_path(directory, threshold)
        row = {"scope": scope, "username": username, "dataset": directory, **asdict(res)}
        results.append(row)
    summary = {"lab": lab, "threshold_days": threshold, "results": results}
    return summary, f"scanned {len(results)} datasets"
