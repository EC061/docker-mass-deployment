from storagehelp import make_cfg

from lab_agent import containerops, labops
from lab_agent.executors import zfs
from lab_agent.storage import service

TB = 1024 ** 4


def _cfg(**kw):
    kw.setdefault("node_name", "n1")
    return make_cfg(**kw)


def _patch_storage(monkeypatch, tmp_path, pools=None, mounted=None):
    """A minimal in-memory ZFS so labops can be exercised without a real pool."""
    pools = pools or {"fast": (10 * TB, 9 * TB), "slow": (20 * TB, 18 * TB)}
    mounted = mounted if mounted is not None else {"fast/labs", "slow/labs"}
    created: list[tuple[str, int | None]] = []
    quotas: list[tuple[str, int | None]] = []
    destroyed: list[str] = []
    usages: dict[str, zfs.Usage] = {}

    monkeypatch.setattr(
        service.zfs, "pool_capacity",
        lambda p: (zfs.PoolCapacity(p, pools[p][0], pools[p][0] - pools[p][1], pools[p][1],
                                    "ONLINE") if p in pools else None),
    )

    def mount_state(dataset, expected=None):
        present = dataset in mounted
        return zfs.MountState(dataset, present, present, expected if present else None, expected)

    def create_dataset(name, *, quota_bytes=None, mountpoint=None, **kw):
        created.append((name, quota_bytes))
        mounted.add(name)
        usages[name] = zfs.Usage(name, 0, quota_bytes, quota_bytes)

    def set_quota(dataset, quota_bytes):
        quotas.append((dataset, quota_bytes))
        prev = usages.get(dataset)
        usages[dataset] = zfs.Usage(dataset, prev.used_bytes if prev else 0,
                                    quota_bytes, quota_bytes)

    def destroy_dataset(name, *, recursive=True):
        destroyed.append(name)
        mounted.discard(name)

    monkeypatch.setattr(service.zfs, "mount_state", mount_state)
    monkeypatch.setattr(service.zfs, "create_dataset", create_dataset)
    monkeypatch.setattr(service.zfs, "mount_dataset", lambda ds: mounted.add(ds))
    monkeypatch.setattr(service.zfs, "set_quota", set_quota)
    monkeypatch.setattr(service.zfs, "destroy_dataset", destroy_dataset)
    monkeypatch.setattr(service.zfs, "dataset_exists", lambda ds: ds in mounted)
    monkeypatch.setattr(service.zfs, "get_usage",
                        lambda ds: usages.get(ds, zfs.Usage(ds, 0, None, None)))
    monkeypatch.setattr(service.mfs, "mount", lambda tier, lab, branches: tier.logical_mount(lab))
    monkeypatch.setattr(service.mfs, "unmount", lambda path: None)
    monkeypatch.setattr("lab_agent.executors.coldfs.ensure_owned_dir", lambda *a, **k: None)
    # Container creation needs Docker — stub it for the storage-focused tests.
    monkeypatch.setattr(containerops, "ensure_container", lambda cfg, lab, params: "container-id")
    monkeypatch.setattr(containerops, "assert_node_ready", lambda cfg: None)
    return created, quotas, destroyed, usages


def test_create_lab_provisions_one_dataset_per_tier(monkeypatch, tmp_path):
    created, _quotas, _destroyed, _ = _patch_storage(monkeypatch, tmp_path)
    cfg = _cfg(state_db=str(tmp_path / "state.db"))
    result, _logs = labops.create_lab(
        cfg, {"lab": "bio", "fast_quota_bytes": 2 * TB, "slow_quota_bytes": 3 * TB}
    )
    assert created == [("fast/labs/bio", 2 * TB), ("slow/labs/bio", 3 * TB)]
    assert result["lab"] == "bio"
    # Container-facing paths are unchanged by the storage redesign.
    assert result["fast_mountpoint"] == "/fast/bio"


def test_create_lab_shards_the_quota_across_a_multi_pool_tier(monkeypatch, tmp_path):
    created, _q, _d, _ = _patch_storage(
        monkeypatch, tmp_path,
        pools={"fast1": (10 * TB, 9 * TB), "fast2": (10 * TB, 9 * TB),
               "slow": (20 * TB, 18 * TB)},
        mounted={"fast1/labs", "fast2/labs", "slow/labs"},
    )
    cfg = _cfg(fast_pools=["fast1", "fast2"], state_db=str(tmp_path / "state.db"))
    labops.create_lab(cfg, {"lab": "bio", "fast_quota_bytes": 2 * TB,
                            "slow_quota_bytes": 3 * TB})
    fast = {name: quota for name, quota in created if name.startswith("fast")}
    assert set(fast) == {"fast1/labs/bio", "fast2/labs/bio"}
    # THE invariant: sum of branch quotas never exceeds the configured lab quota.
    assert sum(fast.values()) <= 2 * TB
    assert sum(fast.values()) == 2 * TB


def test_set_lab_quota_live(monkeypatch, tmp_path):
    _c, quotas, _d, _ = _patch_storage(
        monkeypatch, tmp_path, mounted={"fast/labs", "slow/labs", "fast/labs/bio", "slow/labs/bio"}
    )
    cfg = _cfg(state_db=str(tmp_path / "state.db"))
    labops.set_lab_quota(cfg, {"lab": "bio", "fast_quota_bytes": 4 * TB})
    assert ("fast/labs/bio", 4 * TB) in quotas
    # cold not touched
    assert all(d != "slow/labs/bio" for d, _ in quotas)


def test_set_lab_quota_reshards_across_branches(monkeypatch, tmp_path):
    _c, quotas, _d, usages = _patch_storage(
        monkeypatch, tmp_path,
        pools={"fast1": (10 * TB, 9 * TB), "fast2": (10 * TB, 4 * TB),
               "slow": (20 * TB, 18 * TB)},
        mounted={"fast1/labs", "fast2/labs", "slow/labs", "fast1/labs/bio", "fast2/labs/bio"},
    )
    usages["fast1/labs/bio"] = zfs.Usage("fast1/labs/bio", 1 * TB, 1 * TB, 0)
    usages["fast2/labs/bio"] = zfs.Usage("fast2/labs/bio", 0, 1 * TB, 1 * TB)
    cfg = _cfg(fast_pools=["fast1", "fast2"], state_db=str(tmp_path / "state.db"))
    labops.set_lab_quota(cfg, {"lab": "bio", "fast_quota_bytes": 2 * TB})
    applied = dict(quotas)
    assert sum(applied.values()) <= 2 * TB
    # A branch is never shrunk below what it already holds.
    assert applied["fast1/labs/bio"] >= 1 * TB


def test_destroy_lab_removes_every_branch(monkeypatch, tmp_path):
    _c, _q, destroyed, _ = _patch_storage(
        monkeypatch, tmp_path,
        pools={"fast1": (10 * TB, 9 * TB), "fast2": (10 * TB, 9 * TB),
               "slow": (20 * TB, 18 * TB)},
        mounted={"fast1/labs", "fast2/labs", "slow/labs",
                 "fast1/labs/bio", "fast2/labs/bio", "slow/labs/bio"},
    )
    from lab_agent.executors import docker

    monkeypatch.setattr(docker, "remove_container", lambda name: None)
    cfg = _cfg(fast_pools=["fast1", "fast2"], state_db=str(tmp_path / "state.db"))
    labops.destroy_lab(cfg, {"lab": "bio"})
    assert set(destroyed) == {"fast1/labs/bio", "fast2/labs/bio", "slow/labs/bio"}


def test_destroy_lab_refuses_while_a_branch_is_missing(monkeypatch, tmp_path):
    """A pulled disk is not the same thing as deleted data — refuse rather than half-destroy."""
    import pytest

    _c, _q, destroyed, _ = _patch_storage(
        monkeypatch, tmp_path,
        pools={"fast1": (10 * TB, 9 * TB), "slow": (20 * TB, 18 * TB)},  # fast2 is GONE
        mounted={"fast1/labs", "slow/labs", "fast1/labs/bio", "slow/labs/bio"},
    )
    from lab_agent.executors import docker

    monkeypatch.setattr(docker, "remove_container", lambda name: None)
    cfg = _cfg(fast_pools=["fast1", "fast2"], state_db=str(tmp_path / "state.db"))
    with pytest.raises(service.StorageError, match="unavailable"):
        labops.destroy_lab(cfg, {"lab": "bio"})
    assert destroyed == []
    # ...but an administrator can force it once they know the disk is not coming back.
    labops.destroy_lab(cfg, {"lab": "bio", "force": True})
    assert "fast1/labs/bio" in destroyed


def test_destroy_lab_removes_container_before_datasets(monkeypatch, tmp_path):
    # The container must be removed first; otherwise its bind mounts keep the union/datasets busy
    # and both the unmount and `zfs destroy -r` fail ("dataset is busy").
    _patch_storage(monkeypatch, tmp_path,
                   mounted={"fast/labs", "slow/labs", "fast/labs/bio", "slow/labs/bio"})
    from lab_agent.executors import docker

    order: list[str] = []
    monkeypatch.setattr(docker, "remove_container", lambda name: order.append(f"rm:{name}"))
    monkeypatch.setattr(service.zfs, "destroy_dataset",
                        lambda name, *, recursive=True: order.append(f"destroy:{name}"))
    labops.destroy_lab(_cfg(state_db=str(tmp_path / "state.db")), {"lab": "bio"})
    assert order[0] == "rm:bio-n1"
    assert any(o.startswith("destroy:") for o in order[1:])


def test_destroy_lab_touches_nothing_when_only_the_COLD_tier_is_degraded(monkeypatch, tmp_path):
    """The pre-flight must cover every tier, not just the one destroyed first.

    Teardown order is container -> fast -> cold, and each tier only checked its own branches. With a
    healthy fast tier and a missing cold disk, the container and EVERY student home were destroyed
    and the operation then reported "refusing to destroy the surviving branches while data may still
    exist on the missing disk(s)" — a message that says nothing was destroyed. Reproduced on `geass`:
    `t-bravo`'s container and its 30 GiB of fast data were gone, only the cold datasets survived.
    """
    import pytest

    _c, _q, destroyed, _ = _patch_storage(
        monkeypatch, tmp_path,
        pools={"fast": (10 * TB, 9 * TB)},  # the COLD pool "slow" is GONE; fast is fine
        mounted={"fast/labs", "fast/labs/bio"},
    )
    from lab_agent.executors import docker

    removed: list[str] = []
    monkeypatch.setattr(docker, "remove_container", lambda name: removed.append(name))
    cfg = _cfg(state_db=str(tmp_path / "state.db"))

    with pytest.raises(service.StorageError, match="unavailable"):
        labops.destroy_lab(cfg, {"lab": "bio"})

    assert destroyed == [], "a cold-tier outage must not cost the fast tier"
    assert removed == [], "the container must survive a refused destroy"
