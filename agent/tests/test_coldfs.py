import os

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
