import pytest
from storagehelp import make_cfg

from lab_agent import studentops
from lab_agent.executors import zfs
from lab_agent.executors.coldfs import ColdFsError
from lab_agent.storage import service

TB = 1024 ** 4


def cfg(**kw):
    kw.setdefault("node_name", "n1")
    return make_cfg(**kw)


def patch_storage(monkeypatch, *, fast_pools=("fast",), cold_pools=("slow",), missing=()):
    """Stub the tier observation so student ops run without ZFS."""
    dirs = []
    removed = []
    users = []
    datasets: set[str] = set()

    tiers: dict[str, object] = {}

    def observe(tier, lab, health=None):
        tiers[tier.name] = tier
        pools = fast_pools if tier.name == "fast" else cold_pools
        return [
            service.BranchObservation(
                pool=pool,
                dataset=tier.branch_dataset(pool, lab),
                path=tier.branch_mount(pool, lab),
                present=pool not in missing,
                used=0, quota=None, available=None,
                pool_free=9 * TB, pool_size=10 * TB,
                pool_usable=pool not in missing,
            )
            for pool in pools
        ]

    def inherited_mountpoint(dataset: str) -> str:
        """What ZFS gives a child with no local mountpoint: its lab branch's path + its own name.

        Student datasets are created WITHOUT a mountpoint precisely so this stays true after the
        lab's branch moves (see RETEST-FIND-8), so the stub has to model inheritance rather than
        echo a path back.
        """
        pool, _prefix, tail = dataset.split("/", 2)
        lab, _, user = tail.partition("/")
        tier = tiers["fast" if pool in fast_pools else "cold"]
        return f"{tier.branch_mount(pool, lab)}/{user}"

    monkeypatch.setattr(service, "observe_branches", observe)
    monkeypatch.setattr(studentops.zfs, "get_mountpoint", inherited_mountpoint)
    monkeypatch.setattr(studentops.zfs, "dataset_exists", lambda ds: ds in datasets)
    monkeypatch.setattr(studentops.zfs, "create_dataset",
                        lambda *a, **k: pytest.fail("flat storage unexpectedly created a dataset"))
    monkeypatch.setattr(studentops.zfs, "destroy_dataset",
                        lambda ds, recursive=True: datasets.discard(ds))
    monkeypatch.setattr(studentops.coldstore, "lab_mount", lambda c, lab: "/cold-storage/bio")
    monkeypatch.setattr(studentops.coldfs, "ensure_owned_dir",
                        lambda path, uid, gid: dirs.append((path, uid, gid)))
    monkeypatch.setattr(studentops.coldfs, "remove_child",
                        lambda root, name: removed.append((root, name)))
    monkeypatch.setattr(studentops.users, "add_user",
                        lambda container, user, password, uid, gid:
                        users.append(("add", container, user, uid, gid)))
    monkeypatch.setattr(studentops.users, "verify_ssh_login",
                        lambda container, user, password:
                        users.append(("ssh", container, user)))
    monkeypatch.setattr(studentops.users, "remove_user",
                        lambda container, user: users.append(("remove", container, user)))
    return dirs, removed, users, datasets


def test_add_student_uses_native_host_ownership(monkeypatch):
    dirs, _, calls, _ = patch_storage(monkeypatch)
    result, _ = studentops.add_student(cfg(), {
        "lab": "bio", "username": "alice", "password": "pw", "uid": 10042, "gid": 10042,
    })
    assert result["uid"] == 10042
    # Without a per-student quota the directory is made ONCE, on the logical tier path.
    assert dirs == [("/fast/bio/alice", 10042, 10042),
                    ("/cold-storage/bio/alice", 10042, 10042)]
    assert calls == [("add", "bio-n1", "alice", 10042, 10042),
                     ("ssh", "bio-n1", "alice")]


def test_quota_free_students_use_the_logical_path_on_a_multi_pool_tier(monkeypatch):
    """The directory is created once through the union, not once per branch."""
    dirs, _, _, _ = patch_storage(monkeypatch, fast_pools=("fast1", "fast2"))
    studentops.add_student(cfg(fast_pools=["fast1", "fast2"]), {
        "lab": "bio", "username": "alice", "password": "pw", "uid": 10042, "gid": 10042,
    })
    assert [p for p, _, _ in dirs if p.startswith("/fast")] == ["/fast/bio/alice"]


def test_fast_quota_alone_creates_only_fast_student_dataset(monkeypatch):
    dirs, _, _, _ = patch_storage(monkeypatch)
    created = []
    monkeypatch.setattr(studentops.zfs, "create_dataset",
                        lambda name, **kw: created.append((name, kw)))
    studentops.add_student(cfg(), {
        "lab": "bio", "username": "alice", "password": "pw", "uid": 10042, "gid": 10042,
        "student_fast_quota_bytes": 500 * 1024 ** 3,
    })
    # No mountpoint is passed: the child inherits "/fast/bio" + "/alice" from its lab branch, and an
    # inherited mountpoint is the one that follows the branch when the tier is later promoted.
    assert created == [("fast/labs/bio/alice", {"quota_bytes": 500 * 1024 ** 3})]
    assert ("/cold-storage/bio/alice", 10042, 10042) in dirs


def test_student_datasets_are_created_without_a_pinned_mountpoint(monkeypatch):
    """RETEST-FIND-8: a pinned mountpoint does not follow the lab branch when the tier is promoted.

    Inheritance produces the identical path (parent + name) and survives the move, so the mountpoint
    is never passed. The agent verifies the inherited result instead of assuming it.
    """
    patch_storage(monkeypatch, fast_pools=("fast1", "fast2"))
    created = []
    monkeypatch.setattr(studentops.zfs, "create_dataset",
                        lambda name, **kw: created.append((name, kw)))
    studentops.add_student(cfg(fast_pools=["fast1", "fast2"]), {
        "lab": "bio", "username": "alice", "password": "pw", "uid": 10042, "gid": 10042,
        "student_fast_quota_bytes": 1 * TB,
    })
    assert created, "a per-student quota must create a dataset"
    assert all("mountpoint" not in kw for _name, kw in created)


def test_a_student_dataset_that_inherits_the_wrong_path_is_refused(monkeypatch):
    """The one thing inheritance could get wrong is a branch mounted somewhere unexpected."""
    patch_storage(monkeypatch)
    monkeypatch.setattr(studentops.zfs, "create_dataset", lambda name, **kw: None)
    monkeypatch.setattr(studentops.zfs, "get_mountpoint", lambda ds: "/somewhere/else")
    monkeypatch.setattr(studentops.zfs, "destroy_dataset", lambda ds, recursive=True: None)
    with pytest.raises(RuntimeError, match="inherited mountpoint"):
        studentops._ensure_user_dataset("fast/labs/bio/alice", "/fast/bio/alice", 500, 1, 1)


def test_student_quota_is_sharded_across_branches(monkeypatch):
    """A per-student quota obeys the same sum invariant as the lab quota."""
    patch_storage(monkeypatch, fast_pools=("fast1", "fast2"))
    created = []
    monkeypatch.setattr(studentops.zfs, "create_dataset",
                        lambda name, **kw: created.append((name, kw["quota_bytes"])))
    studentops.add_student(cfg(fast_pools=["fast1", "fast2"]), {
        "lab": "bio", "username": "alice", "password": "pw", "uid": 10042, "gid": 10042,
        "student_fast_quota_bytes": 1 * TB,
    })
    fast = {name: quota for name, quota in created if name.startswith("fast")}
    assert set(fast) == {"fast1/labs/bio/alice", "fast2/labs/bio/alice"}
    assert sum(fast.values()) <= 1 * TB


def test_existing_fast_directory_is_promoted_with_data(tmp_path, monkeypatch):
    home = tmp_path / "alice"
    home.mkdir()
    (home / "work.txt").write_text("preserved")
    datasets = set()
    monkeypatch.setattr(studentops.zfs, "dataset_exists", lambda ds: ds in datasets)
    monkeypatch.setattr(studentops.zfs, "create_dataset",
                        lambda name, **kw: (datasets.add(name), home.mkdir()))
    monkeypatch.setattr(studentops.zfs, "get_mountpoint", lambda ds: str(home))
    monkeypatch.setattr(studentops.zfs, "set_quota", lambda *a: None)
    monkeypatch.setattr(studentops.zfs, "destroy_dataset", lambda ds, recursive: datasets.discard(ds))
    monkeypatch.setattr(studentops.coldfs, "ensure_owned_dir", lambda *a, **k: None)

    studentops._ensure_user_dataset("fast/labs/bio/alice", str(home), 500, 10042, 10042)

    assert (home / "work.txt").read_text() == "preserved"
    assert "fast/labs/bio/alice" in datasets
    assert not (tmp_path / "alice.student-quota-migration").exists()


def test_existing_full_student_dataset_converges_metadata_before_quota_shrink(monkeypatch):
    """BUG-7: a shrink may leave zero headroom, so metadata must be handled first."""
    events = []
    monkeypatch.setattr(studentops.zfs, "dataset_exists", lambda _ds: True)
    monkeypatch.setattr(
        studentops.zfs,
        "get_usage",
        lambda dataset: zfs.Usage(dataset, 23 * 1024**3, 64 * 1024**3, 41 * 1024**3),
    )
    monkeypatch.setattr(
        studentops.coldfs,
        "ensure_owned_dir",
        lambda path, uid, gid: events.append(("ownership", path, uid, gid)),
    )
    monkeypatch.setattr(
        studentops.zfs,
        "set_quota",
        lambda dataset, quota: events.append(("quota", dataset, quota)),
    )

    studentops._ensure_user_dataset(
        "fast/labs/bio/alice", "/fast/bio/alice", 23 * 1024**3, 10042, 10042,
    )

    assert events == [
        ("ownership", "/fast/bio/alice", 10042, 10042),
        ("quota", "fast/labs/bio/alice", 23 * 1024**3),
    ]


def test_existing_full_student_dataset_gets_headroom_before_metadata_repair(monkeypatch):
    """A quota clear/grow should happen first so a real metadata correction has room."""
    events = []
    monkeypatch.setattr(studentops.zfs, "dataset_exists", lambda _ds: True)
    monkeypatch.setattr(
        studentops.zfs,
        "get_usage",
        lambda dataset: zfs.Usage(dataset, 64 * 1024**3, 64 * 1024**3, 0),
    )
    monkeypatch.setattr(
        studentops.coldfs,
        "ensure_owned_dir",
        lambda path, uid, gid: events.append(("ownership", path, uid, gid)),
    )
    monkeypatch.setattr(
        studentops.zfs,
        "set_quota",
        lambda dataset, quota: events.append(("quota", dataset, quota)),
    )

    studentops._ensure_user_dataset(
        "fast/labs/bio/alice", "/fast/bio/alice", None, 10042, 10042,
    )

    assert events == [
        ("quota", "fast/labs/bio/alice", None),
        ("ownership", "/fast/bio/alice", 10042, 10042),
    ]


def test_remove_data_is_host_side_and_cold_is_independent(monkeypatch):
    _, removed, calls, _ = patch_storage(monkeypatch)
    studentops.remove_student(cfg(), {
        "lab": "bio", "username": "alice", "delete_data": True, "delete_cold": False,
    })
    assert calls == [("remove", "bio-n1", "alice")]
    assert removed == [("/fast/bio", "alice")]


def test_remove_data_covers_every_branch(monkeypatch):
    _, removed, _, _ = patch_storage(monkeypatch, fast_pools=("fast1", "fast2"))
    studentops.remove_student(cfg(fast_pools=["fast1", "fast2"]), {
        "lab": "bio", "username": "alice", "delete_data": True,
    })
    assert removed == [("/mnt/lab-storage/fast1/labs/bio", "alice"),
                       ("/mnt/lab-storage/fast2/labs/bio", "alice")]


def test_remove_data_refuses_while_a_branch_is_missing(monkeypatch):
    _, removed, _, _ = patch_storage(monkeypatch, fast_pools=("fast1", "fast2"),
                                     missing=("fast2",))
    with pytest.raises(service.StorageError, match="unavailable"):
        studentops.remove_student(cfg(fast_pools=["fast1", "fast2"]), {
            "lab": "bio", "username": "alice", "delete_data": True,
        })
    assert removed == []


def test_cold_cleanup_is_owner_only(monkeypatch):
    _, removed, _, _ = patch_storage(monkeypatch)
    result, _ = studentops.delete_cold_student(cfg(), {"lab": "bio", "username": "alice"})
    assert result["cold_deleted"] is True
    assert removed == [("/cold-storage/bio", "alice")]

    client = make_cfg(cold_backend="smb")
    with pytest.raises(ColdFsError, match="may not delete"):
        studentops.delete_cold_student(client, {"lab": "bio", "username": "alice"})


def test_student_allocation_never_shrinks_below_used(monkeypatch):
    """Even when the configured student quota drops, no branch goes below what it holds."""
    tier = cfg(fast_pools=["fast1", "fast2"]).storage.fast
    branches = [
        service.BranchObservation("fast1", "fast1/labs/bio", "/b/fast1", True, 0, None, None,
                                  5 * TB, 8 * TB, pool_usable=True),
        service.BranchObservation("fast2", "fast2/labs/bio", "/b/fast2", True, 0, None, None,
                                  5 * TB, 8 * TB, pool_usable=True),
    ]
    monkeypatch.setattr(studentops.zfs, "dataset_exists", lambda ds: True)
    monkeypatch.setattr(studentops.zfs, "get_usage", lambda ds: zfs.Usage(
        ds, 800 * 1024 ** 3 if "fast1" in ds else 0, 1 * TB, 0))
    allocation = studentops._student_allocation(tier, "bio", "alice", 1 * TB, branches)
    assert allocation["fast1"] >= 800 * 1024 ** 3
    assert sum(allocation.values()) <= 1 * TB


def test_student_quota_is_not_redistributed_while_a_branch_is_missing(monkeypatch):
    patch_storage(monkeypatch, fast_pools=("fast1", "fast2"), missing=("fast2",))
    with pytest.raises(service.StorageError, match="refusing to redistribute"):
        studentops.add_student(cfg(fast_pools=["fast1", "fast2"]), {
            "lab": "bio", "username": "alice", "password": "pw",
            "uid": 10042, "gid": 10042, "student_fast_quota_bytes": 1 * TB,
        })


def test_a_branch_with_no_room_is_skipped_not_crashed_on(monkeypatch):
    """A zero allocation is a legitimate allocator result, not an error.

    When a student's logical quota is already fully committed to the data on one branch, the
    allocator pins every branch at its floor — which is 0 for an empty one. ZFS has no zero quota,
    so handing that straight to create_dataset used to fail the whole student.add.
    """
    patch_storage(monkeypatch, fast_pools=("fast1", "fast2"))
    created = []
    monkeypatch.setattr(studentops.zfs, "create_dataset",
                        lambda name, **kw: created.append((name, kw["quota_bytes"])))
    monkeypatch.setattr(studentops.zfs, "dataset_exists",
                        lambda ds: ds == "fast1/labs/bio/alice")
    # alice already fills her whole 1 TB on fast1, so fast2 has nothing left to be given.
    monkeypatch.setattr(studentops.zfs, "get_usage",
                        lambda ds: zfs.Usage(ds, 1 * TB, 1 * TB, 0))
    monkeypatch.setattr(studentops.zfs, "set_quota", lambda ds, q: None)
    studentops.add_student(cfg(fast_pools=["fast1", "fast2"]), {
        "lab": "bio", "username": "alice", "password": "pw", "uid": 10042, "gid": 10042,
        "student_fast_quota_bytes": 1 * TB,
    })
    assert created == []  # fast2 is skipped rather than created with quota=0


def test_a_student_is_refused_when_no_branch_has_room(monkeypatch):
    """Skipping every branch would silently give the student no storage at all."""
    patch_storage(monkeypatch, fast_pools=("fast1",))
    monkeypatch.setattr(studentops.zfs, "dataset_exists", lambda ds: False)
    monkeypatch.setattr(studentops, "_student_allocation",
                        lambda tier, lab, user, quota, branches: {"fast1": 0})
    with pytest.raises(service.StorageError, match="free capacity"):
        studentops.add_student(cfg(fast_pools=["fast1"]), {
            "lab": "bio", "username": "alice", "password": "pw", "uid": 10042, "gid": 10042,
            "student_fast_quota_bytes": 1 * TB,
        })
