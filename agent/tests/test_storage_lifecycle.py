"""End-to-end storage lifecycle against an in-memory ZFS: the scenarios from the design.

The headline case is the one this redesign exists for:

    Day 1     one 8 TB cold drive -> cold1/labs/labA -> /cold-storage/labA, 2 TB quota
    Week 12   install HDD2, initialize cold2, attach it to the cold tier
    After     cold1/labs/labA + cold2/labs/labA -> /cold-storage/labA, STILL 2 TB (not 4 TB)

with no lab recreated, no container path changed, and no file moved.
"""

from __future__ import annotations

import pytest
from fakezfs import FakeZfs, install
from storagehelp import make_cfg

from lab_agent.storage import service
from lab_agent.storage.state import BRANCH_MISSING, StorageState

TB = 1024 ** 4
GB = 1024 ** 3


def test_smb_tier_health_requires_a_real_mount(monkeypatch):
    tier = make_cfg(cold_backend="smb").storage.cold
    monkeypatch.setattr(service.os.path, "ismount", lambda path: False)
    assert service.tier_health(tier) == (service.HEALTH_UNAVAILABLE, [])
    monkeypatch.setattr(service.os.path, "ismount", lambda path: path == tier.cold_root)
    assert service.tier_health(tier) == (service.HEALTH_HEALTHY, [])


def cfg(tmp_path, **kw):
    c = make_cfg(**kw)
    c.state_db = str(tmp_path / "state.db")
    return c


def one_cold_drive(monkeypatch, tmp_path, size=8 * TB):
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", size)
    c = cfg(tmp_path, cold_pools=["cold1"], docker_pool="fast")
    return fake, c


def quotas_of(fake: FakeZfs, prefix: str) -> dict[str, int | None]:
    return {name: ds.quota for name, ds in fake.datasets.items() if name.endswith(prefix)}


# --------------------------------------------------------------------------- day 1


def test_day_one_single_drive_uses_a_plain_zfs_mount(monkeypatch, tmp_path):
    """One disk means no FUSE at all: the dataset mounts straight at the container-facing path."""
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    result = service.provision_lab(c, "cold", "labA", 2 * TB)
    assert result["mountpoint"] == "/cold-storage/labA"
    assert fake.datasets["cold1/labs/labA"].mountpoint == "/cold-storage/labA"
    assert fake.datasets["cold1/labs/labA"].quota == 2 * TB
    assert fake.unions == {}  # nothing was mergerfs-mounted


def test_day_one_quota_is_the_whole_configured_quota(monkeypatch, tmp_path):
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    service.provision_lab(c, "cold", "labA", 2 * TB)
    assert quotas_of(fake, "/labA") == {"cold1/labs/labA": 2 * TB}


def test_a_degraded_zpool_makes_the_logical_tier_degraded(monkeypatch, tmp_path):
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    service.provision_lab(c, "cold", "labA", 2 * TB)
    fake.pools["cold1"].health = "DEGRADED"
    health, pools = service.tier_health(c.storage.cold)
    assert health == service.HEALTH_DEGRADED
    assert pools[0].usable is True  # still accessible, but no longer reported healthy


def test_untrusted_lab_name_never_reaches_a_dataset_or_mount_path(monkeypatch, tmp_path):
    _fake, c = one_cold_drive(monkeypatch, tmp_path)
    with pytest.raises(ValueError, match="invalid lab name"):
        service.provision_lab(c, "cold", "../../root", 2 * TB)


def test_a_new_lab_is_never_created_with_an_unlimited_branch(monkeypatch, tmp_path):
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    with pytest.raises(service.StorageError, match="refusing to create.*unlimited"):
        service.provision_lab(c, "cold", "labA", None)
    assert "cold1/labs/labA" not in fake.datasets


def test_legacy_finite_branch_quota_is_inferred_during_convergence(monkeypatch, tmp_path):
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    service.provision_lab(c, "cold", "labA", 2 * TB)
    # Simulate a pre-storage-state installation while retaining the real ZFS quota.
    StorageState(c.storage_state_path).save()
    result = service.provision_lab(c, "cold", "labA", None)
    assert result["usage"]["quota_bytes"] == 2 * TB
    assert fake.datasets["cold1/labs/labA"].quota == 2 * TB


# --------------------------------------------------------------------------- adding a drive


def test_adding_a_second_drive_preserves_the_lab_quota(monkeypatch, tmp_path):
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    service.provision_lab(c, "cold", "labA", 2 * TB)
    fake.datasets["cold1/labs/labA"].used = 800 * GB
    fake.pools["cold1"].used = 800 * GB

    fake.add_pool("cold2", 8 * TB)
    result = service.attach_pool(c, "cold", "cold2")

    assert result["promoted_to_mergerfs"] is True
    assert c.storage.cold.backend == "mergerfs"
    assert c.storage.cold.pools == ("cold1", "cold2")

    quotas = quotas_of(fake, "/labA")
    assert set(quotas) == {"cold1/labs/labA", "cold2/labs/labA"}
    # THE requirement: still 2 TB in total, NOT 4 TB.
    assert sum(quotas.values()) <= 2 * TB
    # And the branch that already holds 800 GB keeps at least that much.
    assert quotas["cold1/labs/labA"] >= 800 * GB
    assert quotas["cold2/labs/labA"] > 0


def test_adding_a_drive_does_not_move_existing_files(monkeypatch, tmp_path):
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    service.provision_lab(c, "cold", "labA", 2 * TB)
    fake.datasets["cold1/labs/labA"].used = 800 * GB
    fake.add_pool("cold2", 8 * TB)
    service.attach_pool(c, "cold", "cold2")
    # Existing data stays exactly where it was; only the QUOTA moved.
    assert fake.datasets["cold1/labs/labA"].used == 800 * GB
    assert fake.datasets["cold2/labs/labA"].used == 0


def test_adding_a_drive_keeps_the_container_path(monkeypatch, tmp_path):
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    service.provision_lab(c, "cold", "labA", 2 * TB)
    fake.add_pool("cold2", 8 * TB)
    service.attach_pool(c, "cold", "cold2")
    # /cold-storage/labA is now a union of both branches — same path, same bind mount target.
    assert fake.unions["/cold-storage/labA"] == [
        "/mnt/lab-storage/cold1/labs/labA", "/mnt/lab-storage/cold2/labs/labA",
    ]
    assert service.mount_lab(c, "cold", "labA") == "/cold-storage/labA"
    # The backing datasets moved out of container sight, without moving data.
    assert fake.datasets["cold1/labs/labA"].mountpoint == "/mnt/lab-storage/cold1/labs/labA"


def test_promotion_carries_the_per_student_datasets_with_their_lab(monkeypatch, tmp_path):
    """RETEST-FIND-8: promoting cold to mergerfs left every per-student dataset behind.

    A student dataset created with a PINNED mountpoint does not follow its lab when the lab's
    mountpoint moves: `zfs set mountpoint` unmounts the subtree and remounts only what it moved, so
    the child ends up unmounted at a path the layout no longer uses. Its files disappear from the
    new union and the student cannot write. Recovery meant moving four mountpoints by hand.
    """
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    service.provision_lab(c, "cold", "labA", 2 * TB)
    # Legacy shape: pinned to the lab's CURRENT logical path, as older agents created them.
    for user in ("stu1", "stu2"):
        fake.create_dataset(f"cold1/labs/labA/{user}", quota_bytes=64 * GB,
                            mountpoint=f"/cold-storage/labA/{user}")
        fake.datasets[f"cold1/labs/labA/{user}"].used = 4 * GB

    fake.add_pool("cold2", 8 * TB)
    service.attach_pool(c, "cold", "cold2")

    for user in ("stu1", "stu2"):
        child = fake.datasets[f"cold1/labs/labA/{user}"]
        # Under the lab's new branch path, mounted, with its data and quota untouched.
        assert child.mountpoint == f"/mnt/lab-storage/cold1/labs/labA/{user}"
        assert child.mounted is True
        assert child.quota == 64 * GB
        assert child.used == 4 * GB
        # And no longer pinned, so any future move carries it automatically.
        assert child.mountpoint_local is False


def test_promotion_moves_inherited_student_datasets_without_touching_them(monkeypatch, tmp_path):
    """The shape new agents create: inheritance means ZFS itself does the work."""
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    service.provision_lab(c, "cold", "labA", 2 * TB)
    fake.create_dataset("cold1/labs/labA/stu1", quota_bytes=64 * GB)  # inherited mountpoint
    assert fake.datasets["cold1/labs/labA/stu1"].mountpoint == "/cold-storage/labA/stu1"

    fake.add_pool("cold2", 8 * TB)
    service.attach_pool(c, "cold", "cold2")

    child = fake.datasets["cold1/labs/labA/stu1"]
    assert child.mountpoint == "/mnt/lab-storage/cold1/labs/labA/stu1"
    assert child.mounted is True


def test_adding_a_drive_extends_every_existing_lab(monkeypatch, tmp_path):
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    for lab, quota in (("labA", 2 * TB), ("labB", 1 * TB), ("labC", 512 * GB)):
        service.provision_lab(c, "cold", lab, quota)
    fake.add_pool("cold2", 8 * TB)
    result = service.attach_pool(c, "cold", "cold2")

    assert {r["lab"] for r in result["labs"]} == {"labA", "labB", "labC"}
    for lab, quota in (("labA", 2 * TB), ("labB", 1 * TB), ("labC", 512 * GB)):
        assert f"cold2/labs/{lab}" in fake.datasets
        total = sum(v for k, v in quotas_of(fake, f"/{lab}").items())
        assert total <= quota, f"{lab} grew past its configured quota"


def test_attaching_a_pool_to_an_already_mergerfs_tier_is_live(monkeypatch, tmp_path):
    """A third disk joins the LIVE union: no remount, so containers keep their bind mount."""
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 8 * TB)
    fake.add_pool("cold2", 8 * TB)
    c = cfg(tmp_path, cold_pools=["cold1", "cold2"], docker_pool="fast")
    service.provision_lab(c, "cold", "labA", 2 * TB)

    fake.add_pool("cold3", 8 * TB)
    result = service.attach_pool(c, "cold", "cold3")
    assert result["promoted_to_mergerfs"] is False
    assert result["restart_required"] == []
    assert result["labs"][0]["attached_live"] is True
    assert len(fake.unions["/cold-storage/labA"]) == 3
    assert fake.remounts == []


def test_a_failed_live_attach_reports_the_required_restart(monkeypatch, tmp_path):
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 8 * TB)
    fake.add_pool("cold2", 8 * TB)
    fake.live_attach_fails = True
    c = cfg(tmp_path, cold_pools=["cold1", "cold2"], docker_pool="fast")
    service.provision_lab(c, "cold", "labA", 2 * TB)
    fake.add_pool("cold3", 8 * TB)
    result = service.attach_pool(c, "cold", "cold3")
    assert result["restart_required"] == ["labA"]
    assert fake.remounts == ["/cold-storage/labA"]


def test_attaching_an_unknown_or_duplicate_pool_is_refused(monkeypatch, tmp_path):
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    with pytest.raises(service.StorageError, match="does not exist"):
        service.attach_pool(c, "cold", "nosuch")
    with pytest.raises(service.StorageError, match="already backs"):
        service.attach_pool(c, "cold", "cold1")
    fake.add_pool("shared", 1 * TB)
    service.attach_pool(c, "cold", "shared")
    with pytest.raises(service.StorageError, match="already backs the other tier"):
        service.attach_pool(c, "fast", "shared")


# --------------------------------------------------------------------------- new labs after growth


def test_a_lab_created_after_two_pools_exist_is_sharded_immediately(monkeypatch, tmp_path):
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 8 * TB)
    fake.add_pool("cold2", 8 * TB)
    c = cfg(tmp_path, cold_pools=["cold1", "cold2"], docker_pool="fast")
    service.provision_lab(c, "cold", "labNew", 4 * TB)
    quotas = quotas_of(fake, "/labNew")
    assert set(quotas) == {"cold1/labs/labNew", "cold2/labs/labNew"}
    assert sum(quotas.values()) <= 4 * TB
    assert fake.unions["/cold-storage/labNew"] == [
        "/mnt/lab-storage/cold1/labs/labNew", "/mnt/lab-storage/cold2/labs/labNew",
    ]


def test_provisioning_is_idempotent(monkeypatch, tmp_path):
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 8 * TB)
    fake.add_pool("cold2", 8 * TB)
    c = cfg(tmp_path, cold_pools=["cold1", "cold2"], docker_pool="fast")
    first = service.provision_lab(c, "cold", "labA", 2 * TB)
    before = quotas_of(fake, "/labA")
    second = service.provision_lab(c, "cold", "labA", 2 * TB)
    assert quotas_of(fake, "/labA") == before
    assert first["mountpoint"] == second["mountpoint"]


# --------------------------------------------------------------------------- teardown


def test_destroy_removes_every_branch_and_the_union(monkeypatch, tmp_path):
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 8 * TB)
    fake.add_pool("cold2", 8 * TB)
    c = cfg(tmp_path, cold_pools=["cold1", "cold2"], docker_pool="fast")
    service.provision_lab(c, "cold", "labA", 2 * TB)
    service.destroy_lab(c, "cold", "labA")
    assert "cold1/labs/labA" not in fake.datasets
    assert "cold2/labs/labA" not in fake.datasets
    assert "/cold-storage/labA" not in fake.unions
    # The container dataset roots survive for the other labs.
    assert "cold1/labs" in fake.datasets


# --------------------------------------------------------------------------- degraded operation


def _two_pool_lab(monkeypatch, tmp_path):
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 8 * TB)
    fake.add_pool("cold2", 8 * TB)
    c = cfg(tmp_path, cold_pools=["cold1", "cold2"], docker_pool="fast")
    service.provision_lab(c, "cold", "labA", 2 * TB)
    fake.datasets["cold1/labs/labA"].used = 800 * GB
    fake.datasets["cold2/labs/labA"].used = 500 * GB
    return fake, c


def test_a_lost_pool_leaves_the_survivor_readable(monkeypatch, tmp_path):
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    fake.drop_pool("cold1")
    report = service.reconcile_mounts(c)
    assert report["tiers"]["cold"]["health"] == "degraded"
    # The union still comes up, over the surviving branch only.
    assert fake.unions["/cold-storage/labA"] == ["/mnt/lab-storage/cold2/labs/labA"]
    assert report["degraded"][0]["missing"] == ["cold1"]


def test_a_lost_pool_never_becomes_a_plain_directory_branch(monkeypatch, tmp_path):
    """The dead branch path may still exist as an empty directory; it must leave the union."""
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    fake.drop_pool("cold1")
    branches = service.observe_branches(c.storage.cold, "labA")
    gone = next(b for b in branches if b.pool == "cold1")
    assert gone.present is False and gone.pool_usable is False
    service.reconcile_mounts(c)
    assert "/mnt/lab-storage/cold1/labs/labA" not in fake.unions["/cold-storage/labA"]


def test_losing_every_pool_leaves_the_logical_mount_DOWN_on_purpose(monkeypatch, tmp_path):
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    fake.drop_pool("cold1")
    fake.drop_pool("cold2")
    report = service.reconcile_mounts(c)
    assert report["tiers"]["cold"]["health"] == "unavailable"
    # Better an absent mount than a mergerfs union over empty root-filesystem directories.
    assert "/cold-storage/labA" not in fake.unions


def test_a_missing_branch_keeps_its_quota_reserved(monkeypatch, tmp_path):
    """cold1 disappears holding 800 GB; cold2 must NOT be grown to the whole 2 TB."""
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    before = fake.datasets["cold2/labs/labA"].quota
    fake.drop_pool("cold1")
    result = service.rebalance(c, "cold")
    entry = result["labs"][0]
    assert entry["ok"] is True
    assert entry["reserved_bytes"] >= 800 * GB
    assert fake.datasets["cold2/labs/labA"].quota <= before
    assert fake.datasets["cold2/labs/labA"].quota < 2 * TB


def test_a_missing_branch_is_recorded_as_missing_not_forgotten(monkeypatch, tmp_path):
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    fake.drop_pool("cold1")
    service.rebalance(c, "cold")
    state = StorageState.load(c.storage_state_path)
    record = state.lab_or_none("cold", "labA")
    assert record.branches["cold1"].state == BRANCH_MISSING
    assert record.branches["cold1"].quota_bytes is not None


def test_destroying_a_lab_is_blocked_while_a_branch_is_missing(monkeypatch, tmp_path):
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    fake.drop_pool("cold1")
    with pytest.raises(service.StorageError, match="refusing to destroy"):
        service.destroy_lab(c, "cold", "labA")
    assert "cold2/labs/labA" in fake.datasets


def test_a_returning_pool_is_reattached_without_a_remount(monkeypatch, tmp_path):
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    fake.pools["cold1"].imported = False
    service.reconcile_mounts(c)
    assert fake.unions["/cold-storage/labA"] == ["/mnt/lab-storage/cold2/labs/labA"]
    fake.pools["cold1"].imported = True
    service.reconcile_mounts(c)
    assert sorted(fake.unions["/cold-storage/labA"]) == [
        "/mnt/lab-storage/cold1/labs/labA", "/mnt/lab-storage/cold2/labs/labA",
    ]
    assert fake.remounts == []


def test_a_missing_dataset_on_a_healthy_pool_is_recreated_not_reserved(monkeypatch, tmp_path):
    """Distinguishes 'the disk went away' from 'the dataset simply is not there yet'."""
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    del fake.datasets["cold2/labs/labA"]
    service.provision_lab(c, "cold", "labA", 2 * TB)
    assert "cold2/labs/labA" in fake.datasets
    state = StorageState.load(c.storage_state_path)
    assert state.lab_or_none("cold", "labA").branches["cold2"].state == "active"


# --------------------------------------------------------------------------- quota safety


def test_quota_changes_never_transiently_exceed_the_configured_total(monkeypatch, tmp_path):
    """Shrink first, then grow: the committed sum is never above the configured quota mid-flight."""
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    peaks = []
    real_set_quota = fake.set_quota

    def watching_set_quota(name, quota):
        real_set_quota(name, quota)
        peaks.append(sum(
            ds.quota or 0 for n, ds in fake.datasets.items() if n.endswith("/labA")
        ))

    monkeypatch.setattr(service.zfs, "set_quota", watching_set_quota)
    # Move most of the quota onto the branch that holds the data.
    fake.pools["cold2"].used = 7 * TB   # cold2 has little physical room left
    service.rebalance(c, "cold")
    assert peaks, "no quota change was applied"
    assert max(peaks) <= 2 * TB


def test_a_failed_shrink_is_rolled_back(monkeypatch, tmp_path):
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    before = {n: ds.quota for n, ds in fake.datasets.items() if n.endswith("/labA")}
    real_set_quota = fake.set_quota

    def failing(name, quota):
        if name == "cold2/labs/labA" and quota is not None and quota < (before[name] or 0):
            raise service.zfs.ZfsError("simulated I/O error")
        real_set_quota(name, quota)

    monkeypatch.setattr(service.zfs, "set_quota", failing)
    fake.pools["cold1"].used = 0
    fake.pools["cold2"].used = 7 * TB
    result = service.rebalance(c, "cold")
    entry = result["labs"][0]
    if not entry["ok"]:
        assert "rolled back" in entry["error"]
        assert {n: ds.quota for n, ds in fake.datasets.items() if n.endswith("/labA")} == before


def test_quota_reduction_below_used_is_rejected_without_changing_the_record(monkeypatch, tmp_path):
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    before = {n: ds.quota for n, ds in fake.datasets.items() if n.endswith("/labA")}
    with pytest.raises(service.StorageError, match="cannot reduce"):
        service.set_lab_quota(c, "cold", "labA", 1 * TB)
    assert {n: ds.quota for n, ds in fake.datasets.items() if n.endswith("/labA")} == before
    state = StorageState.load(c.storage_state_path)
    assert state.lab_or_none("cold", "labA").configured_quota_bytes == 2 * TB


def test_no_branch_is_left_without_a_quota(monkeypatch, tmp_path):
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    fake.add_pool("cold3", 8 * TB)
    service.attach_pool(c, "cold", "cold3")
    for name, ds in fake.datasets.items():
        if name.endswith("/labA"):
            assert ds.quota is not None, f"{name} was left unlimited"


def test_rebalance_moves_quota_but_never_files(monkeypatch, tmp_path):
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    used_before = {n: ds.used for n, ds in fake.datasets.items()}
    fake.pools["cold1"].used = 7 * TB
    service.rebalance(c, "cold")
    assert {n: ds.used for n, ds in fake.datasets.items()} == used_before


# --------------------------------------------------------------------------- usage aggregation


def test_usage_is_aggregated_into_one_row_per_lab_per_tier(monkeypatch, tmp_path):
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    usage = service.collect_usage(c)
    cold = usage["labA"]["cold"]
    assert cold.used_bytes == 1300 * GB       # 800 + 500, counted once
    assert cold.quota_bytes == 2 * TB          # the configured logical quota
    assert cold.health == "healthy"
    assert len(cold.branches) == 2


def test_available_is_capped_by_physical_free_space(monkeypatch, tmp_path):
    """A branch whose quota promises more than the pool has left must not inflate `available`."""
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    fake.pools["cold2"].used = 8 * TB - 10 * GB    # only 10 GB physically left on cold2
    usage = service.collect_usage(c)["labA"]["cold"]
    cold2 = next(b for b in usage.branches if b.pool == "cold2")
    assert cold2.pool_free == 10 * GB
    assert usage.available_bytes <= (1 * TB - 800 * GB) + 10 * GB


def test_degraded_usage_reports_the_missing_branch(monkeypatch, tmp_path):
    fake, c = _two_pool_lab(monkeypatch, tmp_path)
    service.rebalance(c, "cold")  # record the allocation before the failure
    fake.drop_pool("cold1")
    usage = service.collect_usage(c)["labA"]["cold"]
    assert usage.health == "degraded"
    assert usage.missing_pools == ["cold1"]
    assert usage.used_bytes == 500 * GB          # only what is actually reachable
    assert usage.reserved_bytes > 0              # ...and the lost branch's quota is held back


# --------------------------------------------------------------------------- failed attach


def test_a_failed_attach_puts_the_promoted_datasets_back(monkeypatch, tmp_path):
    """A half-promoted tier is the one outcome worse than a refused attach.

    Promotion moves the container-visible path out from under the lab, but the new topology is only
    written to the config on the success path. If the step after promotion fails, the datasets must
    go back where the (unchanged) config says they are — otherwise the caller restarts containers
    onto an empty root-filesystem /cold-storage/labA.
    """
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    service.provision_lab(c, "cold", "labA", 2 * TB)
    fake.add_pool("cold2", 8 * TB)

    real_create = fake.create_dataset

    def refuse_the_new_pool_root(name, **kw):
        if name == "cold2/labs":
            raise service.zfs.ZfsError("cold2 is suspended")
        return real_create(name, **kw)

    monkeypatch.setattr(service.zfs, "create_dataset", refuse_the_new_pool_root)

    with pytest.raises(service.StorageError, match="container dataset"):
        service.attach_pool(c, "cold", "cold2")

    assert c.storage.cold.pools == ("cold1",)
    assert c.storage.cold.backend == "zfs"
    assert fake.datasets["cold1/labs/labA"].mountpoint == "/cold-storage/labA"
    assert fake.datasets["cold1/labs"].mountpoint == "/cold-storage"


def test_a_promotion_that_fails_midway_restores_the_labs_it_already_moved(monkeypatch, tmp_path):
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    for lab in ("labA", "labB", "labC"):
        service.provision_lab(c, "cold", lab, 1 * TB)
    fake.add_pool("cold2", 8 * TB)

    real_set = fake.set_property

    def refuse_the_third_lab(name, key, value):
        if name == "cold1/labs/labC" and key == "mountpoint":
            raise service.zfs.ZfsError("dataset is busy")
        return real_set(name, key, value)

    monkeypatch.setattr(service.zfs, "set_property", refuse_the_third_lab)

    with pytest.raises(service.StorageError, match="could not promote"):
        service.attach_pool(c, "cold", "cold2")

    assert c.storage.cold.pools == ("cold1",)
    for lab in ("labA", "labB", "labC"):
        assert fake.datasets[f"cold1/labs/{lab}"].mountpoint == f"/cold-storage/{lab}"


def test_a_failed_promotion_puts_the_student_datasets_back_too(monkeypatch, tmp_path):
    """Rollback has the same nesting constraint as the forward move.

    Every mountpoint has to be restored before ANY per-student dataset is remounted: `zfs set
    mountpoint` cannot unmount a dataset while a child is mounted beneath it, so remounting a lab's
    students early would block the restore of the very next lab.
    """
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    for lab in ("labA", "labB", "labC"):
        service.provision_lab(c, "cold", lab, 1 * TB)
        fake.create_dataset(f"cold1/labs/{lab}/stu1", quota_bytes=64 * GB)
    fake.add_pool("cold2", 8 * TB)

    real_set = fake.set_property

    def refuse_the_third_lab(name, key, value):
        if name == "cold1/labs/labC" and key == "mountpoint":
            raise service.zfs.ZfsError("dataset is busy")
        return real_set(name, key, value)

    monkeypatch.setattr(service.zfs, "set_property", refuse_the_third_lab)

    with pytest.raises(service.StorageError, match="could not promote"):
        service.attach_pool(c, "cold", "cold2")

    for lab in ("labA", "labB", "labC"):
        assert fake.datasets[f"cold1/labs/{lab}"].mountpoint == f"/cold-storage/{lab}"
        child = fake.datasets[f"cold1/labs/{lab}/stu1"]
        assert child.mountpoint == f"/cold-storage/{lab}/stu1"
        assert child.mounted is True


def test_promotion_unmounts_labs_then_moves_the_root_then_the_labs(monkeypatch, tmp_path):
    """The only ordering that both succeeds AND leaves the data reachable.

    Observed on `geass` with two provisioned labs:

    * root first  -> `cannot unmount '/cold-storage': pool or dataset is busy`; the whole
      promotion rolls back and the tier stays single-pool forever.
    * labs first  -> succeeds, but the root then mounts ON TOP of the labs' new mountpoints and
      shadows them: `zfs list` still shows the data, every file disappears from the branch
      directory and from the mergerfs union above it.

    So: unmount the labs, move the root, then move the labs so each remounts nested underneath it.
    """
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    for lab in ("labA", "labB"):
        service.provision_lab(c, "cold", lab, 1 * TB)
    fake.add_pool("cold2", 8 * TB)

    calls: list[tuple[str, str]] = []
    real_set, real_unmount = fake.set_property, fake.unmount

    def rec_set(name, key, value):
        if key == "mountpoint":
            calls.append(("move", name))
        return real_set(name, key, value)

    def rec_unmount(name):
        calls.append(("unmount", name))
        return real_unmount(name)

    monkeypatch.setattr(service.zfs, "set_property", rec_set)
    monkeypatch.setattr(service.zfs, "unmount", rec_unmount)
    service.attach_pool(c, "cold", "cold2")

    root_move = calls.index(("move", "cold1/labs"))
    for lab in ("labA", "labB"):
        ds = f"cold1/labs/{lab}"
        assert calls.index(("unmount", ds)) < root_move, (
            f"{ds} must be unmounted before the root moves; got {calls}"
        )
        assert root_move < calls.index(("move", ds)), (
            f"the root must move before {ds}, else it shadows it; got {calls}"
        )

    # End state: everything under branch_root, still mounted, data reachable.
    assert fake.datasets["cold1/labs"].mountpoint == "/mnt/lab-storage/cold1/labs"
    for lab in ("labA", "labB"):
        ds = fake.datasets[f"cold1/labs/{lab}"]
        assert ds.mountpoint == f"/mnt/lab-storage/cold1/labs/{lab}"
        assert ds.mounted


def test_rollback_restores_the_root_before_the_labs(monkeypatch, tmp_path):
    """The undo path has the same nesting constraint, in both halves."""
    fake, c = one_cold_drive(monkeypatch, tmp_path)
    for lab in ("labA", "labB"):
        service.provision_lab(c, "cold", lab, 1 * TB)
    fake.add_pool("cold2", 8 * TB)

    real_create = fake.create_dataset

    def refuse_the_new_pool_root(name, **kw):
        if name == "cold2/labs":
            raise service.zfs.ZfsError("cold2 is suspended")
        return real_create(name, **kw)

    monkeypatch.setattr(service.zfs, "create_dataset", refuse_the_new_pool_root)
    with pytest.raises(service.StorageError):
        service.attach_pool(c, "cold", "cold2")

    assert c.storage.cold.backend == "zfs"
    assert fake.datasets["cold1/labs"].mountpoint == "/cold-storage"
    for lab in ("labA", "labB"):
        ds = fake.datasets[f"cold1/labs/{lab}"]
        assert ds.mountpoint == f"/cold-storage/{lab}", "rollback must restore the original path"
        assert ds.mounted, "a restored dataset must be mounted again, not left detached"
