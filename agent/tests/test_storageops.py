"""Controller-facing storage operations: input validation and destructive-action gating.

The agent runs as root and these handlers take their parameters straight off the wire, so the
important properties here are that nothing hostile can reach an argv and that erasing a disk needs
an explicit confirmation.
"""

from __future__ import annotations

import pytest
from fakezfs import FakeZfs, install
from storagehelp import make_cfg

from lab_agent import storageops
from lab_agent.storage import pools as poolinv
from lab_agent.storage import service
from lab_agent.storage.model import StorageConfigError
from lab_agent.storage.state import StorageState

TB = 1024 ** 4


def cfg(tmp_path, **kw):
    c = make_cfg(**kw)
    c.state_db = str(tmp_path / "state.db")
    return c


# --------------------------------------------------------------------------- device validation


@pytest.mark.parametrize("device", [
    "/dev/sda",                                  # not a stable identity
    "/dev/disk/by-id/../../../etc/passwd",       # traversal
    "/dev/disk/by-id/ata-X; rm -rf /",           # shell metacharacters
    "/dev/disk/by-id/",                          # empty identifier
    "/dev/disk/by-id/nested/path",               # not a direct child
    "/dev/disk/by-uuid/1234",                    # wrong directory
    "",
    None,
    123,
])
def test_invalid_devices_are_rejected(device):
    with pytest.raises(StorageConfigError):
        poolinv.validate_device(device)


def test_valid_by_id_devices_are_accepted():
    for path in ("/dev/disk/by-id/ata-ST8000NM_0001-part1",
                 "/dev/disk/by-id/nvme-Samsung_SSD_990_PRO_S1A",
                 "/dev/disk/by-path/pci-0000:00:17.0-ata-1"):
        assert poolinv.validate_device(path) == path


@pytest.mark.parametrize("vdev", ["raidz9", "stripe", "mirror ; reboot", "-f", 5])
def test_invalid_vdev_types_are_rejected(vdev):
    with pytest.raises(StorageConfigError):
        poolinv.validate_vdev_type(vdev)


def test_valid_vdev_types():
    assert poolinv.validate_vdev_type(None) == ""
    for vdev in ("mirror", "raidz1", "raidz2", "raidz3"):
        assert poolinv.validate_vdev_type(vdev) == vdev


# --------------------------------------------------------------------------- pool creation gating


def test_creating_a_pool_requires_explicit_confirmation(tmp_path, monkeypatch):
    monkeypatch.setattr(poolinv, "create_pool",
                        lambda *a, **k: pytest.fail("a pool was created without confirmation"))
    with pytest.raises(StorageConfigError, match="confirm=true"):
        storageops.create_pool(cfg(tmp_path), {
            "pool": "cold2", "devices": ["/dev/disk/by-id/ata-X"],
        })


def test_creating_a_pool_refuses_a_disk_already_in_use(monkeypatch):
    monkeypatch.setattr(poolinv.zfs, "pool_exists", lambda p: False)
    monkeypatch.setattr(poolinv, "list_block_devices", lambda: [
        poolinv.BlockDevice("sdb", "/dev/disk/by-id/ata-X", "M", "S", 8 * TB, True, "sata",
                            False, True, ["ext4"], None, 1),
    ])
    monkeypatch.setattr(poolinv.zfs, "create_pool",
                        lambda *a, **k: pytest.fail("wiped a disk that was in use"))
    with pytest.raises(StorageConfigError, match="already in use"):
        poolinv.create_pool("cold2", ["/dev/disk/by-id/ata-X"])


def test_creating_a_pool_on_a_free_disk_succeeds(monkeypatch):
    created = {}
    monkeypatch.setattr(poolinv.zfs, "pool_exists", lambda p: False)
    monkeypatch.setattr(poolinv, "list_block_devices", lambda: [
        poolinv.BlockDevice("sdb", "/dev/disk/by-id/ata-X", "M", "S", 8 * TB, True, "sata",
                            False, False, [], None, 0),
    ])
    monkeypatch.setattr(poolinv.zfs, "create_pool",
                        lambda pool, devices, vdev_type="", force=False: created.update(
                            pool=pool, devices=devices, vdev=vdev_type, force=force))
    result = poolinv.create_pool("cold2", ["/dev/disk/by-id/ata-X"])
    assert result["pool"] == "cold2"
    assert created["devices"] == ["/dev/disk/by-id/ata-X"]
    assert created["force"] is False


def test_a_disk_named_by_an_alias_still_resolves_to_its_inventory_entry(monkeypatch, tmp_path):
    """The inventory records ONE by-id link, but a disk has several aliases plus a by-path one.

    Matching the recorded string alone rejected every other spelling of the same disk with a
    misleading "not a whole disk" — and skipped the in-use check with it.
    """
    dev = tmp_path / "sdb"
    dev.write_text("")
    alias = tmp_path / "by-path-alias"
    alias.symlink_to(dev)
    monkeypatch.setattr(poolinv.zfs, "pool_exists", lambda p: False)
    monkeypatch.setattr(poolinv, "list_block_devices", lambda: [
        poolinv.BlockDevice("sdb", "/dev/disk/by-id/ata-PREFERRED", "M", "S", 8 * TB, True,
                            "sata", False, True, ["ext4"], None, 1),
    ])
    monkeypatch.setattr(poolinv.zfs, "create_pool",
                        lambda *a, **k: pytest.fail("wiped a disk that was in use"))
    monkeypatch.setattr(poolinv, "validate_device", lambda d: d)
    monkeypatch.setattr(poolinv.os.path, "realpath",
                        lambda path: "/dev/sdb" if path == str(alias) else path)
    # Resolves to the same disk, so the in-use guard fires instead of "not a whole disk".
    with pytest.raises(StorageConfigError, match="already in use"):
        poolinv.create_pool("cold2", [str(alias)])


def test_two_aliases_for_one_disk_are_rejected(monkeypatch):
    monkeypatch.setattr(poolinv.zfs, "pool_exists", lambda p: False)
    monkeypatch.setattr(poolinv, "list_block_devices", lambda: [
        poolinv.BlockDevice("sdb", "/dev/disk/by-id/ata-X", "M", "S", 8 * TB, True, "sata",
                            False, False, [], None, 0),
    ])
    monkeypatch.setattr(poolinv.os.path, "realpath", lambda path: "/dev/sdb")
    monkeypatch.setattr(poolinv.zfs, "create_pool",
                        lambda *a, **k: pytest.fail("built a pool from one disk listed twice"))
    with pytest.raises(StorageConfigError, match="same disk"):
        poolinv.create_pool("cold2", ["/dev/disk/by-id/ata-X",
                                      "/dev/disk/by-path/pci-0000:00:17.0-ata-1"])


def test_creating_a_pool_that_already_exists_is_refused(monkeypatch):
    monkeypatch.setattr(poolinv.zfs, "pool_exists", lambda p: True)
    with pytest.raises(StorageConfigError, match="already exists"):
        poolinv.create_pool("cold1", ["/dev/disk/by-id/ata-X"])


def test_redundancy_levels_require_enough_devices(monkeypatch):
    monkeypatch.setattr(poolinv.zfs, "pool_exists", lambda p: False)
    with pytest.raises(StorageConfigError, match="at least 3"):
        poolinv.create_pool("cold2", ["/dev/disk/by-id/a", "/dev/disk/by-id/b"],
                            vdev_type="raidz1")
    with pytest.raises(StorageConfigError, match="at least 2"):
        poolinv.create_pool("cold2", ["/dev/disk/by-id/a"], vdev_type="mirror")


def test_the_same_device_cannot_be_listed_twice(monkeypatch):
    monkeypatch.setattr(poolinv.zfs, "pool_exists", lambda p: False)
    with pytest.raises(StorageConfigError, match="more than once"):
        poolinv.create_pool("cold2", ["/dev/disk/by-id/a", "/dev/disk/by-id/a"])


# --------------------------------------------------------------------------- handler validation


@pytest.mark.parametrize("tier", ["scratch", "", None, "../fast", 7])
def test_unknown_tier_names_are_rejected(tmp_path, tier):
    with pytest.raises(StorageConfigError):
        storageops.attach_pool(cfg(tmp_path), {"tier": tier, "pool": "cold2"})


@pytest.mark.parametrize("pool", ["cold2; reboot", "../etc", "mirror", "", None, "c0"])
def test_bad_pool_names_never_reach_zfs(tmp_path, pool, monkeypatch):
    monkeypatch.setattr(service, "attach_pool",
                        lambda *a, **k: pytest.fail("a bad pool name reached the service layer"))
    with pytest.raises(StorageConfigError):
        storageops.attach_pool(cfg(tmp_path), {"tier": "cold", "pool": pool})


def test_attach_preflight_rejects_an_unimported_pool_before_install(tmp_path, monkeypatch):
    monkeypatch.setattr(storageops.zfs, "pool_exists", lambda pool: False)
    monkeypatch.setattr(
        "lab_agent.hostprep.ensure_mergerfs_available",
        lambda: pytest.fail("mergerfs installation ran before pool preflight"),
    )
    with pytest.raises(StorageConfigError, match="not imported"):
        storageops.attach_pool(cfg(tmp_path), {"tier": "cold", "pool": "cold2"})


def test_second_pool_promotion_restarts_only_running_lab_containers(tmp_path, monkeypatch):
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 8 * TB)
    fake.add_pool("cold2", 8 * TB)
    c = cfg(tmp_path, cold_pools=["cold1"], docker_pool="fast")
    service.provision_lab(c, "cold", "labA", 2 * TB)
    service.provision_lab(c, "cold", "labB", 2 * TB)

    calls: list[tuple[str, str]] = []
    monkeypatch.setattr("lab_agent.hostprep.ensure_mergerfs_available", lambda: None)
    monkeypatch.setattr(
        "lab_agent.executors.docker.container_running",
        lambda name: name.startswith("labA-"),
    )
    monkeypatch.setattr(
        "lab_agent.executors.docker.stop_container",
        lambda name: calls.append(("stop", name)),
    )
    monkeypatch.setattr(
        "lab_agent.executors.docker.start_container",
        lambda name: calls.append(("start", name)),
    )

    result, _ = storageops.attach_pool(c, {"tier": "cold", "pool": "cold2"})

    container = f"labA-{c.node_name}"
    assert calls == [("stop", container), ("start", container)]
    assert result["containers_restarted"] == ["labA"]
    assert fake.unions["/cold-storage/labA"] == [
        "/mnt/lab-storage/cold1/labs/labA",
        "/mnt/lab-storage/cold2/labs/labA",
    ]


def test_rebalance_rejects_a_malformed_lab_list(tmp_path):
    with pytest.raises(StorageConfigError, match="list of lab names"):
        storageops.rebalance(cfg(tmp_path), {"tier": "cold", "labs": "labA"})


@pytest.mark.parametrize("delta", [-1, True, "1", 1.5])
def test_rebalance_rejects_a_malformed_deadband(tmp_path, delta):
    with pytest.raises(StorageConfigError, match="non-negative integer"):
        storageops.rebalance(cfg(tmp_path), {"tier": "cold", "min_delta_bytes": delta})


# --------------------------------------------------------------------------- scheduled rebalance


def _lab_quotas(fake, lab="labA"):
    return {name: ds.quota for name, ds in sorted(fake.datasets.items()) if name.endswith(lab)}


def test_rebalance_shifts_quota_off_a_drive_another_consumer_is_filling(monkeypatch, tmp_path):
    """The point of the split: a drive also holding Docker's data-root is handed a smaller share."""
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 4 * TB)
    fake.add_pool("cold2", 4 * TB)
    c = cfg(tmp_path, cold_pools=["cold1", "cold2"], docker_pool="fast")
    service.provision_lab(c, "cold", "labA", 2 * TB)
    # Two identical empty drives split a 2 TB quota evenly.
    assert _lab_quotas(fake) == {"cold1/labs/labA": 1 * TB, "cold2/labs/labA": 1 * TB}

    fake.pools["cold1"].used += 1 * TB  # e.g. Docker's data-root growing on that disk
    storageops.rebalance(c, {"tier": "cold"})

    after = _lab_quotas(fake)
    assert after["cold1/labs/labA"] < 1 * TB < after["cold2/labs/labA"]
    # Quota moves, but the lab's total entitlement does not change.
    assert sum(after.values()) <= 2 * TB


def test_a_repeat_rebalance_within_the_deadband_touches_nothing(monkeypatch, tmp_path):
    """What makes an hourly schedule affordable: a settled tier produces no writes and no log lines."""
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 4 * TB)
    fake.add_pool("cold2", 4 * TB)
    c = cfg(tmp_path, cold_pools=["cold1", "cold2"], docker_pool="fast")
    service.provision_lab(c, "cold", "labA", 2 * TB)
    before = _lab_quotas(fake)

    fake.pools["cold1"].used += 64 * 1024 * 1024  # 64 MiB of drift somewhere on the disk
    result, note = storageops.rebalance(c, {"tier": "cold", "min_delta_bytes": 1024 ** 3})

    assert _lab_quotas(fake) == before
    entry = result["tiers"][0]["labs"][0]
    assert entry["ok"] and not entry["changed"] and entry["logs"] == []
    assert "already balanced" in note


def test_an_unchanged_over_commit_is_only_announced_once(monkeypatch, tmp_path):
    """A standing, admin-actionable condition must not re-alarm on every scheduled pass."""
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 4 * TB)
    fake.add_pool("cold2", 4 * TB)
    c = cfg(tmp_path, cold_pools=["cold1", "cold2"], docker_pool="fast")
    service.provision_lab(c, "cold", "labA", 2 * TB)
    for name, ds in fake.datasets.items():
        if name.endswith("labA"):
            ds.used = 900 * (1024 ** 3)  # 1.8 TB on disk in total

    # An admin drops the lab to 1 TB, below what is already written.
    state = StorageState.load(c.storage_state_path)
    state.lab("cold", "labA").configured_quota_bytes = 1 * TB
    state.save()

    _first, first_note = storageops.rebalance(c, {"tier": "cold"})
    assert "NEWLY over-committed: labA" in first_note

    second, second_note = storageops.rebalance(c, {"tier": "cold"})
    assert "NEWLY over-committed" not in second_note
    assert "1 lab(s) still over-committed" in second_note
    assert second["tiers"][0]["labs"][0]["over_committed"] is True


@pytest.mark.parametrize("quota", [-1, 0, True])
def test_provision_rejects_a_non_positive_quota(tmp_path, quota):
    with pytest.raises(StorageConfigError, match="positive"):
        storageops.provision_lab_storage(
            cfg(tmp_path), {"tier": "fast", "lab": "bio", "quota_bytes": quota}
        )


# --------------------------------------------------------------------------- pool removal


def _two_pool_node(monkeypatch, tmp_path):
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 8 * TB)
    fake.add_pool("cold2", 8 * TB)
    c = cfg(tmp_path, cold_pools=["cold1", "cold2"], docker_pool="fast")
    service.provision_lab(c, "cold", "labA", 2 * TB)
    return fake, c


def test_removing_a_pool_holding_data_needs_confirmation(monkeypatch, tmp_path):
    _fake, c = _two_pool_node(monkeypatch, tmp_path)
    with pytest.raises(StorageConfigError, match="still holds data"):
        storageops.remove_pool(c, {"tier": "cold", "pool": "cold2"})


def test_removing_the_last_pool_of_a_tier_is_refused(monkeypatch, tmp_path):
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 8 * TB)
    c = cfg(tmp_path, cold_pools=["cold1"], docker_pool="fast")
    with pytest.raises(StorageConfigError, match="only pool"):
        storageops.remove_pool(c, {"tier": "cold", "pool": "cold1"})


def test_removing_a_pool_that_does_not_back_the_tier_is_refused(monkeypatch, tmp_path):
    _fake, c = _two_pool_node(monkeypatch, tmp_path)
    with pytest.raises(StorageConfigError, match="does not back"):
        storageops.remove_pool(c, {"tier": "cold", "pool": "fast"})


def test_a_confirmed_removal_detaches_and_releases_the_reservation(monkeypatch, tmp_path):
    fake, c = _two_pool_node(monkeypatch, tmp_path)
    result, note = storageops.remove_pool(c, {"tier": "cold", "pool": "cold2", "confirm": True})
    assert result["pools"] == ["cold1"]
    assert c.storage.cold.pools == ("cold1",)
    assert "released" in note
    # No dataset is destroyed by a detach — the data is still on the disk.
    assert "cold2/labs/labA" in fake.datasets


# --------------------------------------------------------------------------- read-only reporting


def test_status_reports_every_tier_and_pool(monkeypatch, tmp_path):
    fake, c = _two_pool_node(monkeypatch, tmp_path)
    monkeypatch.setattr(service.poolinv, "list_block_devices", lambda: [])
    monkeypatch.setattr(service.poolinv, "pool_devices", lambda pool: [f"/dev/{pool}"])
    report, note = storageops.status(c, {})
    assert set(report["tiers"]) == {"fast", "cold"}
    assert report["tiers"]["cold"]["health"] == "healthy"
    assert [p["name"] for p in report["pools"]] == ["fast", "cold1", "cold2"]
    assert report["docker"]["pool"] == "fast"
    assert "cold: healthy" in note


def test_status_shows_which_tiers_each_pool_backs(monkeypatch, tmp_path):
    fake, c = _two_pool_node(monkeypatch, tmp_path)
    monkeypatch.setattr(service.poolinv, "list_block_devices", lambda: [])
    monkeypatch.setattr(service.poolinv, "pool_devices", lambda pool: [])
    report, _ = storageops.status(c, {"devices": False})
    tiers = {p["name"]: p["tiers"] for p in report["pools"]}
    assert tiers["cold1"] == ["cold"]
    assert tiers["fast"] == ["fast", "docker"]


def test_a_failed_stop_restarts_the_containers_already_stopped(tmp_path, monkeypatch):
    """Stopping is fallible too: lab C failing must not leave labs A and B down for good."""
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 8 * TB)
    fake.add_pool("cold2", 8 * TB)
    c = cfg(tmp_path, cold_pools=["cold1"], docker_pool="fast")
    for lab in ("labA", "labB", "labC"):
        service.provision_lab(c, "cold", lab, 1 * TB)

    from lab_agent.executors import docker

    calls: list[tuple[str, str]] = []
    monkeypatch.setattr("lab_agent.hostprep.ensure_mergerfs_available", lambda: None)
    monkeypatch.setattr(docker, "container_running", lambda name: True)

    def stop(name):
        if name.startswith("labC-"):
            raise docker.DockerError("container is unresponsive")
        calls.append(("stop", name))

    monkeypatch.setattr(docker, "stop_container", stop)
    monkeypatch.setattr(docker, "start_container", lambda name: calls.append(("start", name)))

    with pytest.raises(docker.DockerError):
        storageops.attach_pool(c, {"tier": "cold", "pool": "cold2"})

    node = c.node_name
    assert calls == [
        ("stop", f"labA-{node}"), ("stop", f"labB-{node}"),
        ("start", f"labA-{node}"), ("start", f"labB-{node}"),
    ]


def test_removing_a_pool_restarts_the_labs_it_had_to_remount(tmp_path, monkeypatch):
    """A remount is invisible to a running container: it keeps writing through the old union —
    including the branch that was just detached — until it is restarted."""
    fake = install(monkeypatch, FakeZfs())
    fake.add_pool("fast", 4 * TB)
    fake.add_pool("cold1", 8 * TB)
    fake.add_pool("cold2", 8 * TB)
    c = cfg(tmp_path, cold_pools=["cold1", "cold2"], docker_pool="fast")
    service.provision_lab(c, "cold", "labA", 2 * TB)

    from lab_agent.executors import docker

    # Force the live-drop of the detached branch to fail, so reconcile_mounts falls back to a
    # remount and flags the lab as needing a restart.
    from lab_agent.executors.base import CommandResult

    monkeypatch.setattr(
        service.mfs, "remove_branch_live",
        lambda mountpoint, branch: CommandResult(
            False, ["setfattr"], 1, "", "operation not supported"),
    )
    restarted: list[str] = []
    monkeypatch.setattr(docker, "container_running", lambda name: True)
    monkeypatch.setattr(docker, "restart_container", lambda name: restarted.append(name))

    result, msg = storageops.remove_pool(c, {"tier": "cold", "pool": "cold2", "confirm": True})

    assert restarted == [f"labA-{c.node_name}"]
    assert result["containers_restarted"] == ["labA"]
    assert "restarted containers: labA" in msg
