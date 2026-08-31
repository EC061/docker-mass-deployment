import os
from concurrent.futures import ThreadPoolExecutor

import pytest

from lab_agent.executors import coldfs


def test_ensure_dir_creates_nested(tmp_path):
    target = tmp_path / "labs" / "bio" / "users" / "alice"
    coldfs.ensure_dir(str(target))
    assert target.is_dir()


def test_ensure_dir_is_idempotent(tmp_path):
    target = tmp_path / "labs" / "bio"
    coldfs.ensure_dir(str(target))
    coldfs.ensure_dir(str(target))  # no raise on existing
    assert target.is_dir()


def test_ensure_owned_dir_converges_under_concurrent_shared_creation(tmp_path):
    target = tmp_path / "cold" / "alice"
    target.parent.mkdir()
    uid, gid = os.getuid(), os.getgid()
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: coldfs.ensure_owned_dir(str(target), uid, gid), range(2)))
    stat = target.stat()
    assert target.is_dir()
    assert (stat.st_uid, stat.st_gid, stat.st_mode & 0o777) == (uid, gid, 0o700)


def test_ensure_owned_dir_skips_noop_metadata_writes_at_quota(tmp_path, monkeypatch):
    """BUG-7: even a no-op chown/chmod returns EDQUOT on a completely full ZFS dataset."""
    target = tmp_path / "cold" / "alice"
    target.parent.mkdir()
    target.mkdir(mode=0o700)
    uid, gid = os.getuid(), os.getgid()

    def unexpected(*_args, **_kwargs):
        raise OSError(122, "Disk quota exceeded")

    monkeypatch.setattr(coldfs.os, "chown", unexpected)
    monkeypatch.setattr(coldfs.os, "chmod", unexpected)

    coldfs.ensure_owned_dir(str(target), uid, gid)


def test_ensure_owned_dir_changes_only_metadata_that_differs(tmp_path, monkeypatch):
    target = tmp_path / "cold" / "alice"
    target.parent.mkdir()
    target.mkdir(mode=0o755)
    uid, gid = os.getuid(), os.getgid()
    chowns = []
    real_chmod = os.chmod
    chmods = []

    monkeypatch.setattr(coldfs.os, "chown", lambda *args, **kwargs: chowns.append((args, kwargs)))
    monkeypatch.setattr(
        coldfs.os,
        "chmod",
        lambda *args, **kwargs: (chmods.append((args, kwargs)), real_chmod(*args, **kwargs)),
    )

    coldfs.ensure_owned_dir(str(target), uid, gid)

    assert chowns == []
    assert len(chmods) == 1


def test_remove_tree_deletes_subtree_inside_guard(tmp_path):
    guard = tmp_path / "cold"
    lab = guard / "labs" / "bio"
    coldfs.ensure_dir(str(lab))
    (lab / "f.txt").write_text("x")
    coldfs.remove_tree(str(lab), guard=str(guard))
    assert not lab.exists()
    assert guard.exists()  # root untouched


def test_remove_tree_refuses_to_delete_the_guard_itself(tmp_path):
    guard = tmp_path / "cold"
    coldfs.ensure_dir(str(guard))
    with pytest.raises(coldfs.ColdFsError):
        coldfs.remove_tree(str(guard), guard=str(guard))
    assert guard.exists()


def test_remove_tree_refuses_path_outside_guard(tmp_path):
    guard = tmp_path / "cold"
    outside = tmp_path / "elsewhere"
    coldfs.ensure_dir(str(guard))
    coldfs.ensure_dir(str(outside))
    with pytest.raises(coldfs.ColdFsError):
        coldfs.remove_tree(str(outside), guard=str(guard))
    assert outside.exists()


def test_remove_tree_refuses_sibling_prefix_collision(tmp_path):
    # "/x/cold-evil" must not be considered inside guard "/x/cold" despite the string prefix.
    guard = tmp_path / "cold"
    sibling = tmp_path / "cold-evil"
    coldfs.ensure_dir(str(guard))
    coldfs.ensure_dir(str(sibling))
    with pytest.raises(coldfs.ColdFsError):
        coldfs.remove_tree(str(sibling), guard=str(guard))
    assert sibling.exists()


def test_remove_tree_noop_when_path_missing(tmp_path):
    guard = tmp_path / "cold"
    coldfs.ensure_dir(str(guard))
    # Absent path inside guard: returns quietly before the guard check.
    coldfs.remove_tree(str(guard / "labs" / "ghost"), guard=str(guard))


def test_remove_tree_resolves_symlink_escape(tmp_path):
    # A symlink living inside the guard but pointing outside must not allow escape.
    guard = tmp_path / "cold"
    coldfs.ensure_dir(str(guard))
    outside = tmp_path / "secret"
    coldfs.ensure_dir(str(outside))
    link = guard / "labs"
    os.symlink(str(outside), str(link))
    with pytest.raises(coldfs.ColdFsError):
        coldfs.remove_tree(str(link), guard=str(guard))
    assert outside.exists()
