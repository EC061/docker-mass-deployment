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
