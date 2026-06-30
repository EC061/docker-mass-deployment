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


def ensure_owned_dir(path: str, uid: int, gid: int, *, mode: int = 0o700) -> None:
    """Create a real directory and give it exact numeric ownership without following symlinks."""
    try:
        os.lstat(path)
        if not os.path.isdir(path) or os.path.islink(path):
            raise ColdFsError(f"refusing to use '{path}': expected a real directory")
    except FileNotFoundError:
        os.mkdir(path, mode)
        os.lstat(path)
    os.chown(path, uid, gid, follow_symlinks=False)
    os.chmod(path, mode, follow_symlinks=False)


def remove_child(root: str, name: str) -> None:
    """Remove one direct child below a trusted root, never the root or a symlink target."""
    path = os.path.join(root, name)
    real_root = os.path.realpath(root)
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(root):
        raise ColdFsError(f"refusing to remove '{path}': not a direct child of '{root}'")
    try:
        os.lstat(path)
    except FileNotFoundError:
        return
    if os.path.islink(path):
        os.unlink(path)
        return
    real_path = os.path.realpath(path)
    if not real_path.startswith(real_root + os.sep):
        raise ColdFsError(f"refusing to remove '{path}': escaped '{root}'")
    if os.path.isdir(path):
        shutil.rmtree(path)
    else:
        os.unlink(path)


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
