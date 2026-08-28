"""mergerfs command generation and branch selection.

FUSE cannot be exercised in CI, so these tests pin the two things that actually matter and are
pure: the exact argv/options a mount is built from, and — critically — that a branch is only ever
used when ZFS says its dataset is mounted where we expect. A leftover empty directory must never
become a branch, because that would silently write lab data onto the root filesystem.
"""

from __future__ import annotations

import pytest
from storagehelp import make_cfg

from lab_agent.executors.base import CommandResult
from lab_agent.executors.zfs import MountState
from lab_agent.storage import mergerfs as mfs
from lab_agent.storage.model import MergerfsOptions, StorageConfigError

GB = 1024 ** 3


def tier(**kw):
    kw.setdefault("cold_pools", ["cold1", "cold2"])
    return make_cfg(**kw).storage.cold


# --------------------------------------------------------------------------- options


def test_default_options_match_the_documented_policy():
    opts = MergerfsOptions().validate()
    value = opts.option_string(fsname="lab-cold-labA")
    parts = value.split(",")
    assert "allow_other" in parts
    assert "category.create=mfs" in parts
    assert "moveonenospc=mfs" in parts
    assert f"minfreespace={50 * GB}" in parts
    assert "cache.files=partial" in parts
    assert "dropcacheonclose=true" in parts
    assert "fsname=lab-cold-labA" in parts
    # mergerfs removed use_ino in 2.35; it is deliberately not passed.
    assert "use_ino" not in parts


def test_minfreespace_is_configurable():
    opts = MergerfsOptions(minfreespace_bytes=10 * GB).validate()
    assert f"minfreespace={10 * GB}" in opts.option_string(fsname="x")


@pytest.mark.parametrize("kwargs", [
    {"create_policy": "$(reboot)"},
    {"create_policy": "mfs,allow_other,nonempty"},
    {"moveonenospc": "true; rm -rf /"},
    {"cache_files": "../../etc"},
    {"action_policy": "epall,fsname=evil"},
    {"search_policy": ""},
])
def test_option_values_are_allow_listed(kwargs):
    """Advanced options are structured settings, never free text that could inject a mount flag."""
    with pytest.raises(StorageConfigError):
        MergerfsOptions(**kwargs).validate()


def test_unknown_option_keys_are_rejected():
    with pytest.raises(StorageConfigError, match="unknown mergerfs option"):
        MergerfsOptions.from_dict({"allow_other": True, "sneaky": "x"})


# --------------------------------------------------------------------------- mount argv


def test_mount_argv_lists_branches_and_the_logical_mountpoint():
    t = tier()
    argv = mfs.mount_argv(t, "labA", [
        "/mnt/lab-storage/cold1/labs/labA", "/mnt/lab-storage/cold2/labs/labA",
    ])
    assert argv[0] == "mergerfs"
    assert argv[1] == "-o"
    assert argv[2] == t.mergerfs.option_string(fsname="lab-cold-labA")
    assert argv[3] == "/mnt/lab-storage/cold1/labs/labA:/mnt/lab-storage/cold2/labs/labA"
    assert argv[4] == "/cold-storage/labA"
    # argv style: nothing is a shell string.
    assert all(isinstance(a, str) and "\n" not in a for a in argv)


def test_mount_argv_is_per_lab_not_per_tier():
    """Merging whole `labs` roots would break per-lab quota attribution; each lab gets its own."""
    t = tier()
    a = mfs.mount_argv(t, "labA", [t.branch_mount("cold1", "labA")])
    b = mfs.mount_argv(t, "labB", [t.branch_mount("cold1", "labB")])
    assert a[-1] == "/cold-storage/labA" and b[-1] == "/cold-storage/labB"
    assert "/labs " not in " ".join(a)
    assert a[3] == "/mnt/lab-storage/cold1/labs/labA"
    assert b[3] == "/mnt/lab-storage/cold1/labs/labB"


def test_mounting_with_no_branches_is_refused():
    with pytest.raises(mfs.MergerfsError, match="no backing ZFS branch is mounted"):
        mfs.mount_argv(tier(), "labA", [])


def test_fsname_is_sanitized():
    t = tier()
    argv = mfs.mount_argv(t, "lab_A-1", [t.branch_mount("cold1", "lab_A-1")])
    assert "fsname=lab-cold-lab_A-1" in argv[2]


# --------------------------------------------------------------------------- branch selection


def _probe(monkeypatch, mounted_at: dict[str, str], real_mounts: set[str]):
    monkeypatch.setattr(
        mfs.zfs, "mount_state",
        lambda ds, expected=None: MountState(
            ds, ds in mounted_at, ds in mounted_at, mounted_at.get(ds), expected,
        ),
    )
    monkeypatch.setattr(mfs.os.path, "ismount", lambda p: p in real_mounts)


def test_active_branches_include_only_real_mounted_datasets(monkeypatch):
    t = tier()
    paths = {p: t.branch_mount(p, "labA") for p in ("cold1", "cold2")}
    _probe(monkeypatch,
           {t.branch_dataset("cold1", "labA"): paths["cold1"],
            t.branch_dataset("cold2", "labA"): paths["cold2"]},
           set(paths.values()))
    assert mfs.active_branches(t, "labA") == [paths["cold1"], paths["cold2"]]


def test_a_missing_zfs_mount_is_never_treated_as_an_ordinary_directory(monkeypatch):
    """cold2's disk is gone. Its branch directory may still exist and be EMPTY — not a branch."""
    t = tier()
    _probe(monkeypatch,
           {t.branch_dataset("cold1", "labA"): t.branch_mount("cold1", "labA")},
           # The kernel thinks the leftover path is not a mount; ZFS does not know the dataset.
           {t.branch_mount("cold1", "labA")})
    branches = mfs.active_branches(t, "labA")
    assert branches == [t.branch_mount("cold1", "labA")]
    assert t.branch_mount("cold2", "labA") not in branches


def test_a_dataset_mounted_somewhere_else_is_not_a_branch(monkeypatch):
    """ZFS says the dataset is mounted, but at the WRONG path — reject it."""
    t = tier()
    _probe(monkeypatch,
           {t.branch_dataset("cold1", "labA"): "/somewhere/else",
            t.branch_dataset("cold2", "labA"): t.branch_mount("cold2", "labA")},
           {"/somewhere/else", t.branch_mount("cold2", "labA")})
    assert mfs.active_branches(t, "labA") == [t.branch_mount("cold2", "labA")]


def test_a_path_zfs_calls_mounted_but_the_kernel_does_not_is_rejected(monkeypatch):
    """Both checks must agree; either one alone can be fooled by stale state."""
    t = tier()
    _probe(monkeypatch,
           {t.branch_dataset("cold1", "labA"): t.branch_mount("cold1", "labA")},
           set())  # os.path.ismount says no
    assert mfs.active_branches(t, "labA") == []


def test_degraded_branch_filtering_keeps_configured_order(monkeypatch):
    t = make_cfg(cold_pools=["cold1", "cold2", "cold3"]).storage.cold
    _probe(monkeypatch,
           {t.branch_dataset(p, "labA"): t.branch_mount(p, "labA") for p in ("cold3", "cold1")},
           {t.branch_mount(p, "labA") for p in ("cold3", "cold1")})
    assert mfs.active_branches(t, "labA") == [
        t.branch_mount("cold1", "labA"), t.branch_mount("cold3", "labA"),
    ]


# --------------------------------------------------------------------------- live reconfiguration


def test_adding_a_branch_uses_the_live_control_file_so_containers_keep_running(monkeypatch):
    t = tier()
    calls = []
    monkeypatch.setattr(mfs, "is_mergerfs_mount", lambda p: True)
    monkeypatch.setattr(mfs, "current_branches", lambda p: ["/mnt/lab-storage/cold1/labs/labA"])
    monkeypatch.setattr(mfs, "run",
                        lambda args, **kw: calls.append(args) or CommandResult(True, args, 0))
    monkeypatch.setattr(mfs, "remount",
                        lambda *a: pytest.fail("a live attach must not remount"))
    result = mfs.attach_branch(t, "labA", "/mnt/lab-storage/cold2/labs/labA",
                               ["/mnt/lab-storage/cold1/labs/labA",
                                "/mnt/lab-storage/cold2/labs/labA"])
    assert result.added_live is True and result.remounted is False
    assert calls == [[
        "setfattr", "-n", "user.mergerfs.branches", "-v",
        "+>/mnt/lab-storage/cold2/labs/labA", "/cold-storage/labA/.mergerfs",
    ]]


def test_an_already_attached_branch_is_a_no_op(monkeypatch):
    t = tier()
    monkeypatch.setattr(mfs, "is_mergerfs_mount", lambda p: True)
    monkeypatch.setattr(mfs, "current_branches", lambda p: ["/mnt/lab-storage/cold2/labs/labA"])
    monkeypatch.setattr(mfs, "run", lambda *a, **k: pytest.fail("no command should run"))
    result = mfs.attach_branch(t, "labA", "/mnt/lab-storage/cold2/labs/labA",
                               ["/mnt/lab-storage/cold2/labs/labA"])
    assert result.added_live is False and result.remounted is False


def test_a_failed_live_attach_falls_back_to_a_remount_and_says_so(monkeypatch):
    t = tier()
    remounted = []
    monkeypatch.setattr(mfs, "is_mergerfs_mount", lambda p: True)
    monkeypatch.setattr(mfs, "current_branches", lambda p: [])
    monkeypatch.setattr(mfs, "run",
                        lambda args, **kw: CommandResult(False, args, 1, "", "no xattr support"))
    monkeypatch.setattr(mfs, "remount", lambda t, lab, b: remounted.append(b))
    result = mfs.attach_branch(t, "labA", "/b2", ["/b1", "/b2"])
    assert result.remounted is True
    assert remounted == [["/b1", "/b2"]]
    assert "must be restarted" in result.detail


def test_attaching_to_a_mount_that_does_not_exist_yet_mounts_it(monkeypatch):
    t = tier()
    mounted = []
    monkeypatch.setattr(mfs, "is_mergerfs_mount", lambda p: False)
    monkeypatch.setattr(mfs, "mount", lambda t, lab, b: mounted.append(b) or "/cold-storage/labA")
    result = mfs.attach_branch(t, "labA", "/b2", ["/b1", "/b2"])
    assert mounted == [["/b1", "/b2"]]
    assert result.added_live is False and result.remounted is False


def test_mount_refuses_to_shadow_a_non_mergerfs_mount(monkeypatch, tmp_path):
    t = make_cfg(cold_pools=["cold1", "cold2"], cold_mount_root=str(tmp_path)).storage.cold
    (tmp_path / "labA").mkdir()
    monkeypatch.setattr(mfs, "available", lambda: True)
    monkeypatch.setattr(mfs, "is_mergerfs_mount", lambda p: False)
    monkeypatch.setattr(mfs.os.path, "ismount", lambda p: True)
    with pytest.raises(mfs.MergerfsError, match="not mergerfs"):
        mfs.mount(t, "labA", ["/b1"])


def test_mount_requires_mergerfs_to_be_installed(monkeypatch, tmp_path):
    t = make_cfg(cold_pools=["cold1", "cold2"], cold_mount_root=str(tmp_path)).storage.cold
    monkeypatch.setattr(mfs, "available", lambda: False)
    with pytest.raises(mfs.MergerfsError, match="host-prepare"):
        mfs.mount(t, "labA", ["/b1"])


def test_mount_refuses_to_cover_a_symlink(monkeypatch, tmp_path):
    t = make_cfg(cold_pools=["cold1", "cold2"], cold_mount_root=str(tmp_path)).storage.cold
    (tmp_path / "target").mkdir()
    (tmp_path / "labA").symlink_to(tmp_path / "target")
    monkeypatch.setattr(mfs, "available", lambda: True)
    monkeypatch.setattr(mfs, "is_mergerfs_mount", lambda p: False)
    with pytest.raises(mfs.MergerfsError, match="symlink"):
        mfs.mount(t, "labA", ["/b1"])


def test_current_branches_parses_the_control_file_value(monkeypatch):
    monkeypatch.setattr(
        mfs, "run",
        lambda args, **kw: CommandResult(True, args, 0, "/a=RW:/b=RO:/c=NC", ""),
    )
    assert mfs.current_branches("/cold-storage/labA") == ["/a", "/b", "/c"]


def test_current_branches_is_empty_when_the_control_file_is_unreadable(monkeypatch):
    monkeypatch.setattr(mfs, "run", lambda args, **kw: CommandResult(False, args, 1, "", "nope"))
    assert mfs.current_branches("/cold-storage/labA") == []
