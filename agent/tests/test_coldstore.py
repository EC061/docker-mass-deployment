import pytest
from storagehelp import make_cfg

from lab_agent import coldstore
from lab_agent.executors.coldfs import ColdFsError
from lab_agent.executors.zfs import MountState, PoolCapacity, Usage
from lab_agent.storage import service


def zfs_cfg(**kw):
    return make_cfg(**kw)


def smb_cfg():
    return make_cfg(cold_backend="smb", slow_path="/mnt/cold")


def _online(monkeypatch, pools: dict[str, tuple[int, int]], mounted: set[str]):
    """Pretend the named pools are ONLINE (size, free) and the named datasets are mounted."""
    monkeypatch.setattr(
        service.zfs, "pool_capacity",
        lambda p: (PoolCapacity(p, pools[p][0], pools[p][0] - pools[p][1], pools[p][1], "ONLINE")
                   if p in pools else None),
    )

    def mount_state(dataset, expected=None):
        return MountState(dataset, dataset in mounted, dataset in mounted,
                          expected if dataset in mounted else None, expected)

    monkeypatch.setattr(service.zfs, "mount_state", mount_state)


TB = 1024 ** 4


def _fake_zfs(monkeypatch, tmp_path, pools, mounted, usages=None):
    """A minimal in-memory ZFS: pools with (size, free), a mutable mounted-dataset set."""
    _online(monkeypatch, pools, mounted)
    created = []
    usages = usages if usages is not None else {}

    def create_dataset(name, *, quota_bytes=None, mountpoint=None, **kw):
        created.append((name, {"quota_bytes": quota_bytes, "mountpoint": mountpoint}))
        mounted.add(name)
        usages[name] = Usage(name, 0, quota_bytes, quota_bytes)

    monkeypatch.setattr(service.zfs, "create_dataset", create_dataset)
    monkeypatch.setattr(service.zfs, "mount_dataset", lambda ds: mounted.add(ds))
    monkeypatch.setattr(service.zfs, "get_usage",
                        lambda ds: usages.get(ds, Usage(ds, 0, None, None)))
    monkeypatch.setattr(service.zfs, "set_quota",
                        lambda ds, q: usages.__setitem__(
                            ds, Usage(ds, usages[ds].used_bytes, q, q)))
    monkeypatch.setattr("lab_agent.executors.coldfs.ensure_owned_dir", lambda *a, **k: None)
    monkeypatch.setattr(service.mfs, "mount", lambda tier, lab, branches: tier.logical_mount(lab))
    return created, usages


def test_zfs_owner_creates_one_dataset_per_pool(monkeypatch, tmp_path):
    mounted = {"slow/labs"}
    created, _ = _fake_zfs(monkeypatch, tmp_path, {"slow": (10 * TB, 9 * TB)}, mounted)
    cfg = zfs_cfg()
    cfg.state_db = str(tmp_path / "state.db")
    coldstore.create_lab(cfg, "bio", 3 * TB)
    assert created == [("slow/labs/bio",
                        {"quota_bytes": 3 * TB, "mountpoint": "/cold-storage/bio"})]


def test_multi_pool_owner_shards_one_quota_across_branches(monkeypatch, tmp_path):
    """Two cold pools -> two datasets whose quotas SUM to the configured lab quota, not double it."""
    mounted = {"cold1/labs", "cold2/labs"}
    created, _ = _fake_zfs(
        monkeypatch, tmp_path,
        {"cold1": (8 * TB, 8 * TB), "cold2": (8 * TB, 8 * TB)}, mounted,
    )
    cfg = zfs_cfg(cold_pools=["cold1", "cold2"])
    cfg.state_db = str(tmp_path / "state.db")
    coldstore.create_lab(cfg, "bio", 2 * TB)
    names = [name for name, _ in created]
    assert names == ["cold1/labs/bio", "cold2/labs/bio"]
    total = sum(kw["quota_bytes"] for _, kw in created)
    assert total <= 2 * TB
    # Equal pools of equal size split evenly.
    assert {kw["quota_bytes"] for _, kw in created} == {1 * TB}


def test_smb_refuses_unmounted_fallback(monkeypatch):
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: False)
    with pytest.raises(ColdFsError, match="refusing fallback"):
        coldstore.create_lab(smb_cfg(), "bio", 3000)


def test_smb_uses_flat_lab_root_when_mounted(monkeypatch):
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: True)
    monkeypatch.setattr(coldstore.os, "lstat", lambda path: object())
    monkeypatch.setattr(coldstore.os.path, "isdir", lambda path: True)
    monkeypatch.setattr(coldstore.os.path, "islink", lambda path: False)
    coldstore.create_lab(smb_cfg(), "bio", 3000)
    assert coldstore.lab_mount(smb_cfg(), "bio") == "/mnt/cold/bio"


def test_smb_requires_owner_created_lab_directory(monkeypatch):
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: True)
    monkeypatch.setattr(coldstore.os, "lstat",
                        lambda path: (_ for _ in ()).throw(FileNotFoundError(path)))
    with pytest.raises(ColdFsError, match="provision the owner first"):
        coldstore.create_lab(smb_cfg(), "bio")


def test_smb_destroy_never_removes_shared_owner_directory(monkeypatch):
    monkeypatch.setattr(coldstore.coldfs, "remove_tree",
                        lambda *a, **k: pytest.fail("SMB client attempted shared deletion"))
    coldstore.destroy_lab(smb_cfg(), "bio")


def test_smb_client_never_sets_a_quota_or_scrubs():
    client = smb_cfg()
    assert "quota" not in coldstore.set_lab_quota(client, "bio", 1000).lower() or \
        "owner node" in coldstore.set_lab_quota(client, "bio", 1000)
    # An SMB client owns no cold pools, so it can never scrub the owner's disks.
    assert client.scrub_pools == ["fast"]


def test_smb_status_and_usage(monkeypatch):
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: True)
    status = coldstore.cold_status(smb_cfg())
    assert status["ready"] is True
    assert status["backend"] == "smb"
    assert status["pools"] == []
    # A client measures nothing locally: the owner reports the same data.
    assert coldstore.lab_usage(smb_cfg(), "bio") == Usage("/mnt/cold/bio", 0, None, None)


def test_zfs_status_reports_tier_health(monkeypatch):
    _online(monkeypatch, {"slow": (1000, 900)}, {"slow/labs"})
    status = coldstore.cold_status(zfs_cfg())
    assert status == {
        "backend": "zfs", "mount_path": "/cold-storage", "ready": True, "health": "healthy",
        "pools": [{
            "pool": "slow", "imported": True, "health": "ONLINE", "size_bytes": 1000,
            "free_bytes": 900, "root_ok": True, "root_mount": "/cold-storage", "usable": True,
        }],
    }


def test_zfs_status_is_not_ready_when_the_pool_is_gone(monkeypatch):
    _online(monkeypatch, {}, set())
    status = coldstore.cold_status(zfs_cfg())
    assert status["ready"] is False
    assert status["health"] == "unavailable"


def test_multi_pool_cold_status_reports_degraded_not_unavailable(monkeypatch):
    """One lost disk of two must not take the whole tier down."""
    _online(monkeypatch, {"cold1": (1000, 900)}, {"cold1/labs"})
    status = coldstore.cold_status(zfs_cfg(cold_pools=["cold1", "cold2"]))
    assert status["health"] == "degraded"
    # Still "ready": the surviving branch keeps serving reads and writes.
    assert status["ready"] is True
    assert [p["pool"] for p in status["pools"] if not p["usable"]] == ["cold2"]


def test_owner_and_smb_client_expose_the_same_logical_lab_path(monkeypatch):
    """The SMB interface does not change when the owner grows to several cold pools."""
    monkeypatch.setattr(coldstore.os.path, "ismount", lambda path: True)
    _online(monkeypatch, {"cold1": (1000, 900), "cold2": (1000, 900)},
            {"cold1/labs", "cold2/labs", "cold1/labs/bio", "cold2/labs/bio"})
    monkeypatch.setattr(service.zfs, "get_usage", lambda ds: Usage(ds, 10, 100, 90))
    monkeypatch.setattr(service.mfs, "mount", lambda tier, lab, branches: tier.logical_mount(lab))
    owner = zfs_cfg(cold_pools=["cold1", "cold2"])
    client = make_cfg(cold_backend="smb", slow_path="/cold-storage")
    assert coldstore.lab_mount(owner, "bio") == "/cold-storage/bio"
    assert coldstore.lab_mount(client, "bio") == "/cold-storage/bio"


def test_owner_usage_is_summed_across_branches_exactly_once(monkeypatch):
    _online(monkeypatch, {"cold1": (1000, 400), "cold2": (1000, 600)},
            {"cold1/labs", "cold2/labs", "cold1/labs/bio", "cold2/labs/bio"})
    usages = {"cold1/labs/bio": Usage("cold1/labs/bio", 300, 500, 200),
              "cold2/labs/bio": Usage("cold2/labs/bio", 100, 400, 300)}
    monkeypatch.setattr(service.zfs, "get_usage", lambda ds: usages[ds])
    usage = coldstore.lab_usage(zfs_cfg(cold_pools=["cold1", "cold2"]), "bio")
    assert usage.used_bytes == 400          # 300 + 100, counted once
    assert usage.quota_bytes == 900         # 500 + 400
    assert usage.available_bytes == 500     # min(200,400) + min(300,600)
