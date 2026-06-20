"""Filesystem helpers for the SMB cold-storage backend.

When a node's cold storage is an SMB/CIFS mount of a slow pool owned by another node, this node is
a pure client: it only needs to make the per-lab/per-student directories on the share (so its
containers have a bind-mount source) and remove a lab's sub-tree when the lab is destroyed. It does
not measure usage or set quotas — the owning ZFS node does all monitoring.

``remove_tree`` is guarded: it refuses to delete anything that is not strictly *inside* the
cold-storage root, so a shared share is never wiped by mistake.
"""

from __future__ import annotations

import os
import shutil


class ColdFsError(RuntimeError):
    pass


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


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
