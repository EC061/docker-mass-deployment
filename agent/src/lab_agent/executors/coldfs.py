"""Filesystem-backed cold-storage executor for the SMB backend.

When a node's cold storage is an SMB/CIFS mount there are no ZFS datasets to manage — just
directories on a (possibly shared) network share. These helpers mirror the slice of the zfs
executor the slow tier needs: make directories, measure usage, and remove a lab's sub-tree.

Two deliberate differences from ZFS:
  * No quota enforcement. SMB shares can't be given a per-directory quota with the tools we have,
    so quota requests are accepted and ignored (the controller records them as "not enforced").
  * Destructive operations are guarded: ``remove_tree`` refuses to delete anything that is not
    strictly *inside* the cold-storage root, so a shared share is never wiped by mistake.
"""

from __future__ import annotations

import os
import shutil

from .base import CommandResult, run


class ColdFsError(RuntimeError):
    pass


def is_mounted(path: str) -> bool:
    return os.path.ismount(path)


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def du_bytes(path: str) -> int | None:
    """Apparent size of a directory tree in bytes, or None if it doesn't exist / du fails."""
    if not os.path.isdir(path):
        return None
    res: CommandResult = run(["du", "-sb", path], timeout=600)
    if not res.ok:
        return None
    first = res.stdout.split("\t", 1)[0].split()[0] if res.stdout.strip() else ""
    try:
        return int(first)
    except ValueError:
        return None


def disk_free(path: str) -> tuple[int | None, int | None]:
    """(size_bytes, free_bytes) of the filesystem backing ``path``; (None, None) on error."""
    probe = path
    while probe and not os.path.exists(probe):
        probe = os.path.dirname(probe)
    if not probe:
        return None, None
    try:
        st = os.statvfs(probe)
    except OSError:
        return None, None
    return st.f_blocks * st.f_frsize, st.f_bavail * st.f_frsize


def remove_tree(path: str, *, guard: str) -> None:
    """Recursively delete ``path`` — but only if it is strictly inside ``guard``.

    ``guard`` is the cold-storage root; refusing to delete it (or anything outside it) keeps a
    shared SMB share safe even if a bad lab name is passed.
    """
    if not os.path.isdir(path):
        return
    real_path = os.path.realpath(path)
    real_guard = os.path.realpath(guard)
    if real_path == real_guard or not real_path.startswith(real_guard + os.sep):
        raise ColdFsError(f"refusing to remove '{path}': not inside cold-storage root '{guard}'")
    shutil.rmtree(real_path)
