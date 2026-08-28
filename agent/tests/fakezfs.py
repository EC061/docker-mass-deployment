"""A small in-memory stand-in for ZFS + mergerfs, so storage lifecycle can be tested without a host.

It models only what the storage layer actually depends on: pools with a size/free/health, datasets
with a mountpoint/quota/used, and which datasets are mounted. That is enough to exercise create,
quota resharding, adding a pool to a live tier, degraded operation, and teardown — including the
invariant that a branch is only usable when its dataset is genuinely mounted where expected.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from lab_agent.executors import zfs
from lab_agent.storage import mergerfs as mfs
from lab_agent.storage import service


@dataclass
class FakePool:
    name: str
    size: int
    used: int = 0
    health: str = "ONLINE"
    imported: bool = True

    @property
    def free(self) -> int:
        return max(0, self.size - self.used)


@dataclass
class FakeDataset:
    name: str
    mountpoint: str | None = None
    quota: int | None = None
    used: int = 0
    mounted: bool = True


@dataclass
class FakeZfs:
    pools: dict[str, FakePool] = field(default_factory=dict)
    datasets: dict[str, FakeDataset] = field(default_factory=dict)
    # mountpoint -> branch list, mimicking live mergerfs mounts
    unions: dict[str, list[str]] = field(default_factory=dict)
    remounts: list[str] = field(default_factory=list)
    live_attach_fails: bool = False

    # ------------------------------------------------------------------ helpers
    def add_pool(self, name: str, size: int, used: int = 0) -> FakePool:
        pool = FakePool(name, size, used)
        self.pools[name] = pool
        return pool

    def drop_pool(self, name: str) -> None:
        """Simulate a pulled/failed disk: the pool and all its datasets vanish."""
        self.pools.pop(name, None)
        for ds in list(self.datasets):
            if ds == name or ds.startswith(name + "/"):
                del self.datasets[ds]

    def pool_of(self, dataset: str) -> FakePool | None:
        return self.pools.get(dataset.split("/")[0])

    # ------------------------------------------------------------------ zfs surface
    def pool_capacity(self, pool: str):
        p = self.pools.get(pool)
        if p is None or not p.imported:
            return None
        return zfs.PoolCapacity(pool, p.size, p.used, p.free, p.health)

    def list_pool_names(self) -> list[str]:
        return sorted(self.pools)

    def pool_exists(self, pool: str) -> bool:
        return pool in self.pools

    def dataset_exists(self, name: str) -> bool:
        return name in self.datasets

    def mount_state(self, name: str, expected: str | None = None) -> zfs.MountState:
        ds = self.datasets.get(name)
        if ds is None or self.pool_of(name) is None:
            return zfs.MountState(name, False, False, None, expected)
        return zfs.MountState(name, True, ds.mounted, ds.mountpoint, expected)

    def create_dataset(self, name, *, quota_bytes=None, mountpoint=None, create_parents=True,
                       properties=None) -> None:
        if name in self.datasets:
            if quota_bytes is not None:
                self.set_quota(name, quota_bytes)
            if mountpoint is not None:
                self.datasets[name].mountpoint = mountpoint
            return
        if self.pool_of(name) is None:
            raise zfs.ZfsError(f"cannot create {name}: no such pool")
        self.datasets[name] = FakeDataset(name, mountpoint, quota_bytes, 0, True)

    def mount_dataset(self, name: str) -> None:
        ds = self.datasets.get(name)
        if ds is None:
            raise zfs.ZfsError(f"cannot mount {name}: no such dataset")
        ds.mounted = True

    def set_quota(self, name: str, quota: int | None) -> None:
        ds = self.datasets.get(name)
        if ds is None:
            raise zfs.ZfsError(f"cannot set quota on {name}: no such dataset")
        if quota is not None and quota <= 0:
            raise zfs.ZfsError("refusing a non-positive quota")
        if quota is not None and quota < ds.used:
            raise zfs.ZfsError(f"size is less than current used space ({ds.used})")
        ds.quota = quota

    def set_property(self, name: str, key: str, value: str) -> None:
        ds = self.datasets.get(name)
        if ds is None:
            raise zfs.ZfsError(f"no such dataset {name}")
        if key == "mountpoint":
            # ZFS remounts in place; the data does not move.
            old = ds.mountpoint
            ds.mountpoint = value
            for child in self.datasets.values():
                if child.mountpoint and old and child.mountpoint.startswith(old + "/"):
                    child.mountpoint = value + child.mountpoint[len(old):]
        elif key == "quota":
            ds.quota = None if value == "none" else int(value)

    def get_usage(self, name: str) -> zfs.Usage:
        ds = self.datasets.get(name)
        if ds is None:
            raise zfs.ZfsError(f"no such dataset {name}")
        pool = self.pool_of(name)
        pool_free = pool.free if pool else 0
        avail = pool_free if ds.quota is None else min(max(0, ds.quota - ds.used), pool_free)
        return zfs.Usage(name, ds.used, ds.quota, avail)

    def list_usage(self, root: str) -> list[zfs.Usage]:
        if root not in self.datasets:
            return []
        prefix = root + "/"
        return [
            self.get_usage(name) for name in sorted(self.datasets)
            if name == root or name.startswith(prefix)
        ]

    def destroy_dataset(self, name: str, *, recursive: bool = True) -> None:
        for ds in list(self.datasets):
            if ds == name or (recursive and ds.startswith(name + "/")):
                del self.datasets[ds]

    def scrub_status(self, pool: str):
        return zfs.ScrubStatus(pool, "ONLINE", True, False, 0, None, "")

    # ------------------------------------------------------------------ mergerfs surface
    def is_mergerfs_mount(self, path: str) -> bool:
        return path in self.unions

    def current_branches(self, path: str) -> list[str]:
        return list(self.unions.get(path, []))

    def mfs_mount(self, tier, lab, branches):
        target = tier.logical_mount(lab)
        self.unions[target] = list(branches)
        return target

    def mfs_unmount(self, path: str) -> None:
        self.unions.pop(path, None)

    def mfs_remount(self, tier, lab, branches):
        target = tier.logical_mount(lab)
        self.remounts.append(target)
        self.unions[target] = list(branches)
        return target

    def remove_branch_live(self, mountpoint: str, branch: str):
        from lab_agent.executors.base import CommandResult

        branches = self.unions.get(mountpoint)
        if branches is not None and branch in branches:
            branches.remove(branch)
        return CommandResult(True, ["setfattr", branch, mountpoint], 0, "", "")

    def add_branch_live(self, mountpoint: str, branch: str):
        from lab_agent.executors.base import CommandResult

        args = ["setfattr", branch, mountpoint]
        if self.live_attach_fails:
            return CommandResult(False, args, 1, "", "operation not supported")
        self.unions.setdefault(mountpoint, []).append(branch)
        return CommandResult(True, args, 0, "", "")

    def ismount(self, path: str) -> bool:
        return path in self.unions or any(
            ds.mounted and ds.mountpoint == path for ds in self.datasets.values()
        )


def install(monkeypatch, fake: FakeZfs) -> FakeZfs:
    """Point the storage layer's ZFS/mergerfs/filesystem calls at ``fake``."""
    for module in (service.zfs, mfs.zfs):
        monkeypatch.setattr(module, "pool_capacity", fake.pool_capacity)
        monkeypatch.setattr(module, "pool_exists", fake.pool_exists)
        monkeypatch.setattr(module, "list_pool_names", fake.list_pool_names)
        monkeypatch.setattr(module, "dataset_exists", fake.dataset_exists)
        monkeypatch.setattr(module, "mount_state", fake.mount_state)
        monkeypatch.setattr(module, "create_dataset", fake.create_dataset)
        monkeypatch.setattr(module, "mount_dataset", fake.mount_dataset)
        monkeypatch.setattr(module, "set_quota", fake.set_quota)
        monkeypatch.setattr(module, "set_property", fake.set_property)
        monkeypatch.setattr(module, "get_usage", fake.get_usage)
        monkeypatch.setattr(module, "list_usage", fake.list_usage)
        monkeypatch.setattr(module, "destroy_dataset", fake.destroy_dataset)
        monkeypatch.setattr(module, "scrub_status", fake.scrub_status)
    monkeypatch.setattr(mfs, "available", lambda: True)
    monkeypatch.setattr(mfs, "is_mergerfs_mount", fake.is_mergerfs_mount)
    monkeypatch.setattr(mfs, "current_branches", fake.current_branches)
    monkeypatch.setattr(mfs, "mount", fake.mfs_mount)
    monkeypatch.setattr(mfs, "unmount", fake.mfs_unmount)
    monkeypatch.setattr(mfs, "remount", fake.mfs_remount)
    monkeypatch.setattr(mfs, "add_branch_live", fake.add_branch_live)
    monkeypatch.setattr(mfs, "remove_branch_live", fake.remove_branch_live)
    monkeypatch.setattr(service.mfs, "remove_branch_live", fake.remove_branch_live)
    monkeypatch.setattr(service.mfs, "remount", fake.mfs_remount)
    monkeypatch.setattr(service.mfs, "current_branches", fake.current_branches)
    monkeypatch.setattr(service.mfs, "is_mergerfs_mount", fake.is_mergerfs_mount)
    monkeypatch.setattr(mfs.os.path, "ismount", fake.ismount)
    monkeypatch.setattr(service.mfs, "mount", fake.mfs_mount)
    monkeypatch.setattr(service.mfs, "unmount", fake.mfs_unmount)
    monkeypatch.setattr("lab_agent.executors.coldfs.ensure_owned_dir", lambda *a, **k: None)
    monkeypatch.setattr("lab_agent.executors.coldfs.remove_child", lambda *a, **k: None)
    return fake
