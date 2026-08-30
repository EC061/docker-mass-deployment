"""Storage operations: provision, quota, mount, expand, report.

Everything that touches a lab's storage goes through here so that "one pool" and "N pools" are the
same code path. Callers (labops, coldstore, studentops, containerops, telemetry, doctor, the
dispatcher) never need to know how many pools back a tier.

Layering:

    model   layout + validated config          (pure)
    quota   how much each branch may hold      (pure)
    state   what a branch owns while missing   (json file)
    pools   physical devices + zpool inventory (zpool/lsblk)
    mergerfs per-lab union mounts              (mergerfs/fuse)
    service  <- you are here: composes the above into safe operations
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ..executors import zfs
from ..executors.users import USERNAME_RE
from ..paths import validate_lab_name
from ..protocol import now_ms
from . import mergerfs as mfs
from . import pools as poolinv
from .model import (
    BACKEND_SMB,
    TIER_COLD,
    TIER_FAST,
    StorageConfig,
    StorageConfigError,
    TierConfig,
    validate_pool_name,
)
from .quota import Allocation, BranchState, allocate, plan_steps
from .state import BRANCH_REMOVED, StorageState

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..config import AgentConfig

# Tier-level health, mirrored in telemetry and the WebUI.
# Dataset names directly below a lab that are never a student, from the pre-flattening layout.
RESERVED_CHILDREN = frozenset({"shared", "users"})

HEALTH_HEALTHY = "healthy"
HEALTH_DEGRADED = "degraded"
HEALTH_UNAVAILABLE = "unavailable"


class StorageError(RuntimeError):
    pass


def _state(cfg: AgentConfig) -> StorageState:
    return StorageState.load(cfg.storage_state_path)


# --------------------------------------------------------------------------- pool / tier health


@dataclass
class PoolHealth:
    pool: str
    imported: bool
    health: str
    size_bytes: int
    free_bytes: int
    # The tier's per-pool container dataset (<pool>/labs) and whether it is mounted where we expect.
    root_ok: bool
    root_mount: str | None

    @property
    def usable(self) -> bool:
        return self.imported and self.health.upper() in ("ONLINE", "DEGRADED") and self.root_ok

    def to_dict(self) -> dict[str, Any]:
        return {
            "pool": self.pool,
            "imported": self.imported,
            "health": self.health,
            "size_bytes": self.size_bytes,
            "free_bytes": self.free_bytes,
            "root_ok": self.root_ok,
            "root_mount": self.root_mount,
            "usable": self.usable,
        }


def pool_health(tier: TierConfig, pool: str) -> PoolHealth:
    """Whether one pool of a tier can currently back branches."""
    capacity = zfs.pool_capacity(pool)
    if capacity is None:
        return PoolHealth(pool, False, "UNAVAIL", 0, 0, False, None)
    root = tier.pool_root_dataset(pool)
    expected = tier.pool_root_mount(pool)
    mount = zfs.mount_state(root, expected)
    return PoolHealth(
        pool=pool,
        imported=True,
        health=capacity.health,
        size_bytes=capacity.size,
        free_bytes=capacity.free,
        root_ok=mount.ok,
        root_mount=mount.mountpoint,
    )


def tier_health(tier: TierConfig) -> tuple[str, list[PoolHealth]]:
    """Return logical tier health and the health of every locally owned pool.

    An SMB client owns no pools, but its logical tier is only usable while the owner's share is a
    real mount.  Treating an ordinary fallback directory as healthy would have the same dangerous
    root-filesystem failure mode that the ZFS branch checks prevent.
    """
    if not tier.is_zfs_owned:
        return (
            HEALTH_HEALTHY if tier.backend == BACKEND_SMB and os.path.ismount(tier.cold_root)
            else HEALTH_UNAVAILABLE,
            [],
        )
    healths = [pool_health(tier, pool) for pool in tier.pools]
    usable = [h for h in healths if h.usable]
    if not usable:
        return HEALTH_UNAVAILABLE, healths
    if len(usable) < len(healths) or any(h.health.upper() != "ONLINE" for h in usable):
        return HEALTH_DEGRADED, healths
    return HEALTH_HEALTHY, healths


def usable_pools(tier: TierConfig) -> list[str]:
    """Pools of a tier that can safely take writes right now."""
    return [h.pool for h in tier_health(tier)[1] if h.usable]


# --------------------------------------------------------------------------- tier roots


def ensure_tier_roots(tier: TierConfig) -> list[str]:
    """Create/converge the per-pool container dataset (``<pool>/labs``) for every usable pool.

    Returns the pools that are ready. A pool that is not imported is skipped, never faked with a
    plain directory — that is what would silently put lab data on the root filesystem.
    """
    ready: list[str] = []
    if not tier.is_zfs_owned:
        return ready
    for pool in tier.pools:
        if not zfs.pool_exists(pool):
            continue
        dataset = tier.pool_root_dataset(pool)
        zfs.create_dataset(dataset, mountpoint=tier.pool_root_mount(pool))
        zfs.mount_dataset(dataset)
        ready.append(pool)
    return ready


# --------------------------------------------------------------------------- branch observation


@dataclass
class BranchObservation:
    """One branch of one lab, as observed right now.

    ``present`` and ``pool_usable`` are deliberately separate. A branch on a healthy pool whose
    dataset does not exist yet is NOT present (nothing to read from) but IS allocatable — that is a
    branch waiting to be created, e.g. a freshly attached disk. A branch whose POOL is gone is
    neither, and its quota stays reserved for it.
    """

    pool: str
    dataset: str
    path: str
    present: bool
    used: int
    quota: int | None
    available: int | None
    pool_free: int
    pool_size: int
    pool_usable: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "pool": self.pool,
            "dataset": self.dataset,
            "path": self.path,
            "present": self.present,
            "pool_usable": self.pool_usable,
            "used_bytes": self.used,
            "quota_bytes": self.quota,
            "available_bytes": self.available,
            "pool_free_bytes": self.pool_free,
            "pool_size_bytes": self.pool_size,
        }

    def branch_state(self) -> BranchState:
        """The allocator's view: a creatable branch counts as available with zero usage."""
        return BranchState(
            pool=self.pool,
            used=self.used,
            quota=self.quota,
            pool_free=self.pool_free,
            available=self.present or self.pool_usable,
        )


def observe_branches(
    tier: TierConfig, lab: str, *, health: list[PoolHealth] | None = None
) -> list[BranchObservation]:
    """Live per-branch facts for one lab, in configured pool order.

    A branch counts as present only when its pool is usable AND the dataset itself is mounted at the
    expected path (``zfs.mount_state``). A leftover empty directory never qualifies.
    """
    healths = {h.pool: h for h in (health if health is not None else tier_health(tier)[1])}
    out: list[BranchObservation] = []
    for pool in tier.pools:
        dataset = tier.branch_dataset(pool, lab)
        path = tier.branch_mount(pool, lab)
        info = healths.get(pool)
        pool_free = info.free_bytes if info else 0
        pool_size = info.size_bytes if info else 0
        if info is None or not info.usable:
            out.append(BranchObservation(pool, dataset, path, False, 0, None, None,
                                         pool_free, pool_size, pool_usable=False))
            continue
        mount = zfs.mount_state(dataset, path)
        if not mount.exists:
            # The pool is fine, the dataset just is not there yet: creatable, not missing.
            out.append(BranchObservation(pool, dataset, path, False, 0, None, None,
                                         pool_free, pool_size, pool_usable=True))
            continue
        usage = zfs.get_usage(dataset)
        out.append(BranchObservation(
            pool, dataset, path, mount.ok, usage.used_bytes, usage.quota_bytes,
            usage.available_bytes, pool_free, pool_size, pool_usable=True,
        ))
    return out


# --------------------------------------------------------------------------- usage aggregation


@dataclass
class TierUsage:
    """One lab's usage on one tier, aggregated across branches into ONE logical number.

    ``used_bytes`` counts only branches that are present, so a pulled disk shows up as a drop in
    usage plus a DEGRADED tier — never as phantom data. ``reserved_bytes`` is the quota still held
    by missing branches, which is why it is not available to the survivors.
    """

    tier: str
    lab: str
    used_bytes: int = 0
    quota_bytes: int | None = None
    available_bytes: int | None = None
    reserved_bytes: int = 0
    health: str = HEALTH_HEALTHY
    branches: list[BranchObservation] = field(default_factory=list)
    missing_pools: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "tier": self.tier,
            "lab": self.lab,
            "used_bytes": self.used_bytes,
            "quota_bytes": self.quota_bytes,
            "available_bytes": self.available_bytes,
            "reserved_bytes": self.reserved_bytes,
            "health": self.health,
            "missing_pools": list(self.missing_pools),
            "branches": [b.to_dict() for b in self.branches],
        }


def aggregate(
    tier_name: str,
    lab: str,
    branches: list[BranchObservation],
    *,
    configured_quota: int | None = None,
) -> TierUsage:
    """Fold branch observations into one logical tier usage.

    Each branch lives on a DIFFERENT pool (the model forbids a pool backing two tiers and a pool
    appearing twice in one tier), so summing per-branch numbers double-counts nothing.

    ``available`` is deliberately not a naive sum of ZFS ``available``: it is capped per branch by
    the backing pool's free space as well, so a branch whose quota promises 1 TB on a pool with
    200 GB left contributes 200 GB, not 1 TB.
    """
    present = [b for b in branches if b.present]
    missing = [b for b in branches if not b.present]
    used = sum(b.used for b in present)
    quota_sum: int | None = 0
    for b in present:
        if b.quota is None:
            quota_sum = None
            break
        quota_sum += b.quota
    available = 0
    for b in present:
        headroom = b.available if b.available is not None else max(0, b.pool_free)
        available += max(0, min(headroom, b.pool_free))
    if not present:
        health = HEALTH_UNAVAILABLE
    elif missing:
        health = HEALTH_DEGRADED
    else:
        health = HEALTH_HEALTHY
    return TierUsage(
        tier=tier_name,
        lab=lab,
        used_bytes=used,
        # The logical quota the controller configured wins when known; otherwise report what the
        # branches actually enforce.
        quota_bytes=configured_quota if configured_quota is not None else quota_sum,
        available_bytes=available if present else None,
        reserved_bytes=0,
        health=health,
        branches=branches,
        missing_pools=[b.pool for b in missing],
    )


# --------------------------------------------------------------------------- provisioning


def _configured_quota(
    state: StorageState, tier: TierConfig, lab: str, requested: int | None
) -> int | None:
    """The lab's logical tier quota: the request when given, else the last recorded one."""
    if requested is not None:
        return requested
    record = state.lab_or_none(tier.name, lab)
    return record.configured_quota_bytes if record else None


def plan_allocation(
    tier: TierConfig,
    lab: str,
    configured: int,
    branches: list[BranchObservation],
    state: StorageState,
) -> Allocation:
    """Compute target branch quotas, honouring reservations for missing branches."""
    observed = {b.pool: b for b in branches}
    states: list[BranchState] = []
    for pool in tier.pools:
        obs = observed.get(pool)
        if obs is None:
            continue
        branch_state = obs.branch_state()
        if not branch_state.available:
            # The POOL is gone (a creatable branch is still "available" above), so this branch
            # keeps the allocation last recorded for it: its capacity is NOT handed to the
            # survivors, because the disk may come back holding data. The LIVE observation decides
            # that the branch is missing — the stored state string is only consulted to see whether
            # an administrator has explicitly RELEASED the branch, which is the one thing that
            # frees its reservation.
            record = state.lab_or_none(tier.name, lab)
            remembered = record.branches.get(pool) if record else None
            if remembered is not None and remembered.state != BRANCH_REMOVED:
                branch_state = BranchState(
                    pool=pool,
                    used=remembered.used_bytes or 0,
                    quota=remembered.quota_bytes,
                    pool_free=0,
                    available=False,
                )
        states.append(branch_state)
    return allocate(configured, states, min_headroom=tier.min_branch_headroom_bytes)


def apply_allocation(
    tier: TierConfig,
    lab: str,
    allocation: Allocation,
    branches: list[BranchObservation],
    *,
    min_delta: int = 0,
) -> list[str]:
    """Apply target quotas in an order that never over-commits, rolling back a failed shrink.

    Shrinks free budget and therefore run first; grows spend it and run second. If a shrink fails we
    undo the shrinks already applied and abort, because the following grows would then push the sum
    past the configured quota. If a *grow* fails the invariant still holds (we only ever grow into
    budget the shrinks already freed), so the partial result is reported rather than unwound.

    ``min_delta`` is the deadband described in ``quota.plan_steps``: below it this lab's quotas are
    left exactly as they are and no log line is produced.
    """
    observed = {b.pool: b for b in branches if b.present}
    current = {pool: obs.quota for pool, obs in observed.items()}
    datasets = {pool: obs.dataset for pool, obs in observed.items()}
    steps = plan_steps(allocation, current, datasets, min_delta=min_delta)
    logs: list[str] = []
    applied: list[tuple[str, int | None]] = []
    for step in steps:
        obs = observed[step.pool]
        if step.target <= 0:
            # The branch's pool has no free space at all, so there is no positive quota to set.
            # Leave whatever finite quota it already has (never "none") and say so.
            logs.append(
                f"PARTIAL: {step.dataset} has no free capacity on pool {step.pool}; its quota is "
                f"left at {step.current}"
            )
            continue
        if step.target < obs.used:
            raise StorageError(
                f"refusing to set quota {step.target} below the {obs.used} bytes already on "
                f"{step.dataset}"
            )
        try:
            zfs.set_quota(step.dataset, step.target)
        except zfs.ZfsError as exc:
            if step.is_shrink:
                for dataset, previous in reversed(applied):
                    try:
                        zfs.set_quota(dataset, previous)
                    except zfs.ZfsError:
                        logs.append(f"ROLLBACK FAILED for {dataset}; inspect quotas manually")
                raise StorageError(
                    f"could not shrink quota on {step.dataset}: {exc}; rolled back"
                ) from exc
            logs.append(
                f"PARTIAL: could not grow quota on {step.dataset} to {step.target}: {exc}. "
                "The tier stays within its configured quota; retry a rebalance."
            )
            continue
        applied.append((step.dataset, step.current))
        logs.append(f"{step.dataset} quota {step.current} -> {step.target}")
    return logs


def provision_lab(
    cfg: AgentConfig,
    tier_name: str,
    lab: str,
    quota_bytes: int | None,
    *,
    uid: int = 0,
    gid: int = 0,
    mode: int = 0o711,
) -> dict[str, Any]:
    """Create/converge one lab's storage on a tier and return its logical mount + usage.

    Idempotent, and safe to call on every pool count:

    1. ensure the per-pool container datasets exist and are mounted where we expect;
    2. compute the branch quota split for the lab's configured logical quota;
    3. create any missing branch dataset **with its quota already set** (never transiently
       unlimited) and converge the existing ones through the safe shrink-then-grow order;
    4. mount (or converge) the per-lab mergerfs union when the tier uses more than one pool.
    """
    lab = validate_lab_name(lab)
    if quota_bytes is not None and (
        isinstance(quota_bytes, bool) or not isinstance(quota_bytes, int) or quota_bytes <= 0
    ):
        raise StorageError("a lab tier quota must be a positive integer byte count")
    tier = cfg.storage.tier(tier_name)
    if not tier.is_zfs_owned:
        raise StorageError(f"{tier_name} tier is backend '{tier.backend}'; nothing to provision")
    state = _state(cfg)
    configured = _configured_quota(state, tier, lab, quota_bytes)
    ensure_tier_roots(tier)
    healths = tier_health(tier)[1]
    ready = [h.pool for h in healths if h.usable]
    if not ready:
        raise StorageError(
            f"no pool of the {tier_name} tier is available "
            f"({', '.join(tier.pools) or 'none configured'}); refusing to provision '{lab}'"
        )

    branches = observe_branches(tier, lab, health=healths)
    if configured is None:
        # Compatibility for pre-state-file installations: infer the logical quota from existing
        # finite branch quotas.  A genuinely new lab still needs an explicit hard quota; creating
        # an unlimited dataset, even briefly, would defeat the storage contract.
        existing = [b for b in branches if b.present]
        finite = [b.quota for b in existing if b.quota is not None]
        if existing and len(finite) == len(existing):
            configured = sum(finite)
        else:
            raise StorageError(
                f"no finite {tier_name} quota is configured for '{lab}'; refusing to create or "
                "converge an unlimited branch dataset"
            )
    allocation = plan_allocation(tier, lab, configured, branches, state)
    if allocation.over_committed:
        raise StorageError(
            f"cannot enforce the requested {tier_name} quota {configured} for '{lab}': "
            + "; ".join(allocation.warnings)
        )
    logs: list[str] = []

    # 3. Create missing branch datasets with their target quota applied atomically at creation.
    from ..executors import coldfs

    for obs in branches:
        if obs.pool not in ready or obs.present:
            continue
        target = allocation.quotas.get(obs.pool)
        if target is None or target <= 0:
            logs.append(
                f"skipped {obs.dataset}: pool {obs.pool} has no free capacity to allocate"
            )
            continue
        zfs.create_dataset(obs.dataset, quota_bytes=target, mountpoint=obs.path)
        zfs.mount_dataset(obs.dataset)
        logs.append(f"created {obs.dataset} (quota={target}) at {obs.path}")
    # Re-observe so newly created branches are counted as present.
    branches = observe_branches(tier, lab, health=healths)
    allocation = plan_allocation(tier, lab, configured, branches, state)
    logs += apply_allocation(tier, lab, allocation, branches)
    logs += list(allocation.warnings)

    # Managed labs run --userns=host, so the mount roots are owned by real host uid 0.
    for obs in branches:
        if obs.present:
            coldfs.ensure_owned_dir(obs.path, uid, gid, mode=mode)

    mountpoint = mount_lab(cfg, tier_name, lab, branches=branches)
    coldfs.ensure_owned_dir(mountpoint, uid, gid, mode=mode)

    _record(state, tier, lab, configured, branches)
    state.save()

    usage = aggregate(tier_name, lab, branches, configured_quota=configured)
    return {
        "tier": tier_name,
        "lab": lab,
        "mountpoint": mountpoint,
        "usage": usage.to_dict(),
        "allocation": dict(allocation.quotas),
        "logs": logs,
    }


def _record(
    state: StorageState,
    tier: TierConfig,
    lab: str,
    configured: int | None,
    branches: list[BranchObservation],
) -> None:
    record = state.lab(tier.name, lab)
    if configured is not None:
        record.configured_quota_bytes = configured
    stamp = now_ms()
    for pool in tier.pools:
        state.record_pool(tier.name, pool, now_ms=stamp)
    for obs in branches:
        state.observe_branch(
            tier.name, lab, obs.pool, present=obs.present, pool_available=obs.pool_usable,
            quota_bytes=obs.quota, used_bytes=obs.used, now_ms=stamp,
        )


def mount_lab(
    cfg: AgentConfig,
    tier_name: str,
    lab: str,
    *,
    branches: list[BranchObservation] | None = None,
) -> str:
    """The container-facing path for one lab on one tier, mounting the union if needed.

    Single-pool ``zfs`` tiers mount the dataset straight at ``<mount_root>/<lab>`` and never involve
    mergerfs, so a node with one disk pays no FUSE cost.
    """
    lab = validate_lab_name(lab)
    tier = cfg.storage.tier(tier_name)
    if not tier.uses_mergerfs:
        pool = tier.pools[0]
        dataset = tier.branch_dataset(pool, lab)
        mount = zfs.mount_state(dataset, tier.branch_mount(pool, lab))
        if not mount.ok:
            raise StorageError(
                f"{dataset} is not mounted at {tier.branch_mount(pool, lab)}; refusing to expose "
                "an unmounted fallback directory to a container"
            )
        return mount.mountpoint or tier.branch_mount(pool, lab)
    observations = branches if branches is not None else observe_branches(tier, lab)
    paths = [b.path for b in observations if b.present]
    if not paths:
        raise StorageError(
            f"no mounted ZFS branch backs {tier.logical_mount(lab)}; refusing to create a mergerfs "
            "union over empty directories"
        )
    return mfs.mount(tier, lab, paths)


def set_lab_quota(
    cfg: AgentConfig, tier_name: str, lab: str, quota_bytes: int | None
) -> dict[str, Any]:
    """Change a lab's logical tier quota and reshard it across the branches."""
    lab = validate_lab_name(lab)
    if quota_bytes is not None and (
        isinstance(quota_bytes, bool) or not isinstance(quota_bytes, int) or quota_bytes <= 0
    ):
        raise StorageError("a lab tier quota must be a positive integer byte count")
    tier = cfg.storage.tier(tier_name)
    if not tier.is_zfs_owned:
        return {"tier": tier_name, "lab": lab, "applied": False,
                "logs": [f"{tier_name} quota is managed by the storage owner (backend "
                         f"'{tier.backend}')"]}
    state = _state(cfg)
    healths = tier_health(tier)[1]
    branches = observe_branches(tier, lab, health=healths)
    if quota_bytes is None:
        # Clearing a lab's quota would leave unlimited datasets behind. Refuse: a tier quota is a
        # hard limit by design, and "unlimited" is expressed as a quota equal to pool capacity.
        raise StorageError("a lab tier quota may not be cleared; set an explicit byte count")
    allocation = plan_allocation(tier, lab, quota_bytes, branches, state)
    if allocation.over_committed:
        # Do not persist a logical quota that the underlying hard quotas physically cannot enforce.
        # The existing allocation remains authoritative until data is removed or the admin chooses
        # a value at least as large as the committed usage/reservations.
        raise StorageError(
            f"cannot reduce the {tier_name} quota for '{lab}' to {quota_bytes}: "
            + "; ".join(allocation.warnings)
        )
    logs = apply_allocation(tier, lab, allocation, branches)
    logs += list(allocation.warnings)
    branches = observe_branches(tier, lab, health=healths)
    _record(state, tier, lab, quota_bytes, branches)
    state.save()
    return {
        "tier": tier_name,
        "lab": lab,
        "applied": True,
        "allocation": dict(allocation.quotas),
        "reserved_bytes": allocation.reserved,
        "over_committed": allocation.over_committed,
        "usage": aggregate(tier_name, lab, branches, configured_quota=quota_bytes).to_dict(),
        "logs": logs,
    }


def destroy_lab(cfg: AgentConfig, tier_name: str, lab: str, *, force: bool = False) -> list[str]:
    """Unmount the lab's union and destroy its branch datasets.

    Refuses while any branch is MISSING unless forced: an absent dataset on a pulled disk is not the
    same thing as "already deleted", and destroying the survivors would make the returning disk's
    copy the only remaining data with no record of what it belongs to.
    """
    lab = validate_lab_name(lab)
    tier = cfg.storage.tier(tier_name)
    if not tier.is_zfs_owned:
        return [f"{tier_name} tier is backend '{tier.backend}'; the owner destroys the data"]
    state = _state(cfg)
    branches = observe_branches(tier, lab)
    # A branch is "missing" only when its POOL is unavailable. A dataset that simply does not exist
    # on a healthy pool is nothing to protect.
    missing = [b.pool for b in branches if not b.pool_usable]
    if missing and not force:
        raise StorageError(
            f"branch(es) {', '.join(missing)} of '{lab}' are unavailable; refusing to destroy the "
            "surviving branches while data may still exist on the missing disk(s). "
            "Restore the pool, or remove it from the tier first."
        )
    logs: list[str] = []
    if tier.uses_mergerfs:
        mfs.unmount(tier.logical_mount(lab))
        logs.append(f"unmounted {tier.logical_mount(lab)}")
    for obs in branches:
        if obs.present or zfs.dataset_exists(obs.dataset):
            zfs.destroy_dataset(obs.dataset, recursive=True)
            logs.append(f"destroyed {obs.dataset}")
    state.forget_lab(tier.name, lab)
    state.save()
    return logs


# --------------------------------------------------------------------------- online expansion


def attach_pool(
    cfg: AgentConfig,
    tier_name: str,
    pool: str,
    *,
    labs: list[str] | None = None,
) -> dict[str, Any]:
    """Add an existing ZFS pool to a tier and extend every lab onto it, quota-neutrally.

    This is the "I installed a second disk months later" path. It never recreates a lab, never
    changes a container path, and never changes a lab's total quota:

    1. promote a single-pool ``zfs`` tier to ``mergerfs`` (moving the existing datasets' mountpoints
       under ``branch_root``; the data itself does not move);
    2. create ``<newpool>/labs``;
    3. for each existing lab: compute a new split of its EXISTING configured quota, shrink the old
       branch first, then create the new branch dataset with the remainder already applied;
    4. attach the new branch to the lab's live mergerfs mount (no remount, so running containers
       keep working) — falling back to a remount, which is reported as needing a restart.

    Returns the per-lab outcome, including which labs need a container restart.
    """
    validate_pool_name(pool)
    tier = cfg.storage.tier(tier_name)
    if tier.backend == BACKEND_SMB:
        raise StorageError("an SMB cold tier has no local pools; the owner node manages them")
    if pool in tier.pools:
        raise StorageError(f"pool '{pool}' already backs the {tier_name} tier")
    if pool in cfg.storage.tier(TIER_COLD if tier_name == TIER_FAST else TIER_FAST).pools:
        raise StorageError(f"pool '{pool}' already backs the other tier")
    if not zfs.pool_exists(pool):
        raise StorageError(f"ZFS pool '{pool}' does not exist on this node")

    promoted = tier.backend != "mergerfs"
    new_tier = tier.with_pools((*tier.pools, pool))
    if not new_tier.uses_mergerfs:  # pragma: no cover - with_pools promotes past one pool
        raise StorageError("attaching a pool requires the mergerfs backend")

    logs: list[str] = []
    state = _state(cfg)
    existing_labs = (
        [validate_lab_name(lab) for lab in labs]
        if labs is not None else discover_labs(tier)
    )
    restart_needed: list[str] = []

    # 1. Promotion: move the existing single-pool datasets out of the container-visible path so the
    #    mergerfs union can take it over. `zfs set mountpoint` remounts in place — no data moves.
    moved: list[str] = []
    if promoted:
        promote_logs, moved = _promote_to_mergerfs(tier, new_tier, existing_labs)
        logs += promote_logs
        restart_needed = list(existing_labs)

    # 2. The new pool's container dataset. Everything from here on is per-lab and fails soft, so
    #    this is the last step that can strand a promoted tier: if it fails, put the datasets back
    #    where the (still unwritten) config says they are rather than leaving the container-visible
    #    paths pointing at empty root-filesystem directories.
    try:
        zfs.create_dataset(new_tier.pool_root_dataset(pool),
                           mountpoint=new_tier.pool_root_mount(pool))
        zfs.mount_dataset(new_tier.pool_root_dataset(pool))
    except Exception as exc:
        failed = _demote_from_mergerfs(tier, new_tier, existing_labs, moved) if promoted else []
        detail = f"; MANUAL RECOVERY NEEDED: {'; '.join(failed)}" if failed else ""
        raise StorageError(
            f"could not create the container dataset for pool '{pool}': {exc}{detail}"
        ) from exc
    logs.append(f"created {new_tier.pool_root_dataset(pool)}")

    healths = tier_health(new_tier)[1]
    results: list[dict[str, Any]] = []
    for lab in existing_labs:
        try:
            results.append(
                _extend_lab_onto(cfg, new_tier, lab, pool, state, healths, restart_needed)
            )
        except (StorageError, zfs.ZfsError, mfs.MergerfsError) as exc:
            recovery = ""
            if promoted:
                # Promotion already moved the original branch away from the logical path. Even if
                # the NEW branch cannot be allocated, restore the stable application path as a
                # one-branch mergerfs union so the controlled container restart can succeed.
                try:
                    surviving = [
                        b.path for b in observe_branches(new_tier, lab, health=healths)
                        if b.present
                    ]
                    if surviving:
                        mfs.mount(new_tier, lab, surviving)
                        recovery = "; logical path restored over surviving branch(es)"
                except (StorageError, zfs.ZfsError, mfs.MergerfsError) as recovery_exc:
                    recovery = f"; logical-path recovery failed: {recovery_exc}"
            results.append({"lab": lab, "ok": False, "error": f"{exc}{recovery}"})
            logs.append(f"lab '{lab}': {exc}{recovery}")

    state.record_pool(tier_name, pool, now_ms=now_ms())
    state.save()
    cfg.storage = cfg.storage.with_tier(new_tier)
    return {
        "tier": tier_name,
        "pool": pool,
        "backend": new_tier.backend,
        "promoted_to_mergerfs": promoted,
        "labs": results,
        "restart_required": sorted(set(restart_needed)),
        "logs": logs,
        # The caller persists this so the new membership survives a reboot.
        "storage": cfg.storage.to_dict(),
    }


def _promote_to_mergerfs(
    old: TierConfig, new: TierConfig, labs: list[str],
) -> tuple[list[str], list[str]]:
    """Move a single-pool tier's datasets under ``branch_root`` so mergerfs can own the mount root.

    Changing a ZFS ``mountpoint`` unmounts and remounts the dataset at the new path; the data is
    untouched. Any container bind-mounted at the old path keeps pointing at the old (now detached)
    inode, which is why the caller reports these labs as needing a restart.

    All-or-nothing: the caller only commits the new topology to the config once this returns, so a
    partial move would leave the container-visible paths and the config disagreeing. Anything
    already moved when a later dataset refuses to remount is put back first.
    """
    logs: list[str] = []
    pool = old.pools[0]
    moved: list[str] = []
    try:
        # Order matters twice over, and both halves are load-bearing:
        #
        # 1. UNMOUNT the per-lab datasets first. `zfs set mountpoint` unmounts before it remounts,
        #    and ZFS refuses to unmount a dataset while a child is still mounted underneath it, so
        #    moving the root with labs mounted fails with
        #    "cannot unmount '<mount_root>': pool or dataset is busy".
        # 2. Move the ROOT before the children. Moving the children first also clears (1), but the
        #    root then mounts *on top of* the children's new mountpoints and shadows them: the
        #    datasets keep their data, `zfs list` still shows it, and every file silently vanishes
        #    from the branch directory and from the mergerfs union above it.
        #
        # So: unmount children -> move root -> move children (each remounting nested under the
        # root's new mount).
        branches = [
            (lab, new.branch_dataset(pool, lab))
            for lab in labs
            if zfs.dataset_exists(new.branch_dataset(pool, lab))
        ]
        for _, dataset in branches:
            zfs.unmount(dataset)
        root = new.pool_root_dataset(pool)
        if zfs.dataset_exists(root):
            zfs.set_property(root, "mountpoint", new.pool_root_mount(pool))
            moved.append(root)
            logs.append(
                f"moved {root} to {new.pool_root_mount(pool)} "
                "(data unchanged; mergerfs now owns the tier mount root)"
            )
        for lab, dataset in branches:
            zfs.set_property(dataset, "mountpoint", new.branch_mount(pool, lab))
            moved.append(dataset)
            logs.append(f"moved {dataset} to {new.branch_mount(pool, lab)}")
    except Exception as exc:
        failed = _demote_from_mergerfs(old, new, labs, moved)
        detail = (
            "; ".join(failed) if failed
            else "the datasets already moved were restored to their original mountpoints"
        )
        raise StorageError(
            f"could not promote the {old.name} tier to mergerfs: {exc} ({detail})"
        ) from exc
    return logs, moved


def _demote_from_mergerfs(
    old: TierConfig, new: TierConfig, labs: list[str], moved: list[str],
) -> list[str]:
    """Undo :func:`_promote_to_mergerfs` for ``moved``, returning the datasets that would not move.

    Best effort by design: a dataset that refuses to remount is reported rather than raised on, so
    one stuck lab cannot stop the others from being restored. A non-empty return means the node is
    genuinely half-promoted and needs an admin.
    """
    pool = old.pools[0]
    originals = {new.pool_root_dataset(pool): old.pool_root_mount(pool)}
    for lab in labs:
        originals[new.branch_dataset(pool, lab)] = old.branch_mount(pool, lab)
    failed: list[str] = []
    # Same nesting constraint as the forward move, and `reversed(moved)` satisfies neither half of
    # it: unmount the deepest datasets first so the tier root is free to be unmounted, then restore
    # shallowest-first so each child remounts *under* the restored root instead of being shadowed
    # by it.
    for dataset in sorted(moved, key=lambda name: name.count("/"), reverse=True):
        try:
            zfs.unmount(dataset)
        except zfs.ZfsError:  # best effort: a stuck child must not stop the rest being restored
            pass
    for dataset in sorted(moved, key=lambda name: name.count("/")):
        target = originals.get(dataset)
        if target is None:  # pragma: no cover - `moved` only ever holds keys of `originals`
            continue
        try:
            zfs.set_property(dataset, "mountpoint", target)
        except zfs.ZfsError as exc:
            failed.append(f"{dataset} could not be restored to {target}: {exc}")
    return failed


def _extend_lab_onto(
    cfg: AgentConfig,
    tier: TierConfig,
    lab: str,
    pool: str,
    state: StorageState,
    healths: list[PoolHealth],
    restart_needed: list[str],
) -> dict[str, Any]:
    """Give one existing lab a branch on a newly attached pool without changing its total quota."""
    from ..executors import coldfs

    lab = validate_lab_name(lab)
    branches = observe_branches(tier, lab, health=healths)
    record = state.lab_or_none(tier.name, lab)
    configured = record.configured_quota_bytes if record else None
    if configured is None:
        # No recorded logical quota (e.g. a lab created before this bookkeeping existed): fall back
        # to what the existing branches already enforce, so the total is preserved exactly.
        quotas = [b.quota for b in branches if b.present and b.quota is not None]
        configured = sum(quotas) if quotas else None

    new_branch = next(b for b in branches if b.pool == pool)
    if configured is None:
        raise StorageError(
            f"cannot extend '{lab}' onto {pool}: no finite existing {tier.name} quota could be "
            "inferred; set an explicit lab quota first (an unlimited new branch is never created)"
        )
    else:
        allocation = plan_allocation(tier, lab, configured, branches, state)
        if allocation.over_committed:
            raise StorageError(
                f"cannot extend '{lab}': its {tier.name} quota is already below committed usage"
            )
        allocation_map = dict(allocation.quotas)
        target = allocation_map.get(pool, 0)
        if target <= 0:
            raise StorageError(
                f"cannot extend '{lab}' onto {pool}: no positive quota can be transferred without "
                "shrinking an existing branch below its used data"
            )
        # Shrink the existing branches FIRST so the new dataset's quota comes out of freed budget;
        # the total is never transiently above `configured`.
        existing = [b for b in branches if b.present]
        previous = {b.dataset: b.quota for b in existing}
        shrink_only = Allocation(
            quotas={p: q for p, q in allocation.quotas.items() if p != pool},
            reserved=allocation.reserved, warnings=(),
        )
        apply_allocation(tier, lab, shrink_only, existing)
        try:
            zfs.create_dataset(
                new_branch.dataset, quota_bytes=target, mountpoint=new_branch.path,
            )
            zfs.mount_dataset(new_branch.dataset)
        except zfs.ZfsError as exc:
            # A failed add must not strand the old branches at their reduced allocations.  If the
            # empty new dataset exists, remove it first; only then is restoring donors quota-safe.
            if zfs.dataset_exists(new_branch.dataset):
                try:
                    zfs.destroy_dataset(new_branch.dataset, recursive=True)
                except zfs.ZfsError as destroy_exc:
                    raise StorageError(
                        f"could not finish {new_branch.dataset} ({exc}) and could not remove the "
                        f"partial dataset ({destroy_exc}); donor quotas remain safely shrunk. "
                        "Inspect and retry the attach operation."
                    ) from exc
            rollback_errors: list[str] = []
            for dataset, prior in previous.items():
                try:
                    zfs.set_quota(dataset, prior)
                except zfs.ZfsError as rollback_exc:
                    rollback_errors.append(f"{dataset}: {rollback_exc}")
            if rollback_errors:
                raise StorageError(
                    f"could not create {new_branch.dataset}: {exc}; quota rollback also failed for "
                    + "; ".join(rollback_errors)
                ) from exc
            raise StorageError(
                f"could not create {new_branch.dataset}: {exc}; restored the original quotas"
            ) from exc
    # Match the ownership/mode of an existing branch so the container sees no change.
    template = next((b for b in branches if b.present), None)
    uid, gid, mode = 0, 0, 0o711
    if template is not None:
        try:
            import os as _os

            st = _os.stat(template.path)
            uid, gid, mode = st.st_uid, st.st_gid, st.st_mode & 0o7777
        except OSError:
            pass
    coldfs.ensure_owned_dir(new_branch.path, uid, gid, mode=mode)

    branches = observe_branches(tier, lab, health=healths)
    attach = mfs.attach_branch(
        tier, lab, new_branch.path, [b.path for b in branches if b.present]
    )
    if attach.remounted:
        restart_needed.append(lab)
    _record(state, tier, lab, configured, branches)
    return {
        "lab": lab,
        "ok": True,
        "configured_quota_bytes": configured,
        "allocation": allocation_map,
        "mountpoint": attach.mountpoint,
        "attached_live": attach.added_live,
        "restart_required": attach.remounted,
        "detail": attach.detail,
    }


def discover_labs(tier: TierConfig) -> list[str]:
    """Lab names that already have a dataset on any pool of the tier."""
    labs: set[str] = set()
    for pool in tier.pools:
        root = tier.pool_root_dataset(pool)
        prefix = root + "/"
        for usage in zfs.list_usage(root):
            if not usage.dataset.startswith(prefix):
                continue
            name = usage.dataset[len(prefix):].split("/")[0]
            if name:
                labs.add(name)
    return sorted(labs)


# --------------------------------------------------------------------------- rebalance / reconcile


def rebalance(
    cfg: AgentConfig,
    tier_name: str,
    labs: list[str] | None = None,
    *,
    min_delta: int = 0,
) -> dict[str, Any]:
    """Recompute + reapply every lab's branch quota split on a tier.

    Moves QUOTA, never files: changing a ZFS quota is instant and free, while relocating data is
    neither. New writes land on the branch with the most free space, so capacity rebalances itself
    over time.

    ``min_delta`` is the deadband (see ``quota.plan_steps``). A lab whose targets all moved by less
    than it comes back ``changed: False`` with empty logs, which is what makes this cheap enough to
    put on an hourly schedule without drowning the log.

    Each lab also reports ``over_committed_changed``: whether its over-commit status differs from
    the last run. An unchanged over-commit is a standing condition only an admin can clear, so the
    caller can report the transition once rather than on every scheduled pass.
    """
    tier = cfg.storage.tier(tier_name)
    if not tier.is_zfs_owned:
        return {"tier": tier_name, "labs": [], "skipped": f"backend '{tier.backend}'"}
    health, healths = tier_health(tier)
    state = _state(cfg)
    results = []
    selected_labs = (
        [validate_lab_name(lab) for lab in labs]
        if labs is not None else discover_labs(tier)
    )
    for lab in selected_labs:
        branches = observe_branches(tier, lab, health=healths)
        record = state.lab_or_none(tier.name, lab)
        configured = record.configured_quota_bytes if record else None
        if configured is None:
            results.append({"lab": lab, "ok": False,
                            "error": "no configured tier quota recorded for this lab"})
            continue
        was_over = record.over_committed if record else False
        try:
            allocation = plan_allocation(tier, lab, configured, branches, state)
            logs = apply_allocation(tier, lab, allocation, branches, min_delta=min_delta)
            # Re-observe only when something actually changed; an untouched lab's numbers are
            # already in `branches`, and re-reading them would double this loop's ZFS calls.
            _record(
                state, tier, lab, configured,
                observe_branches(tier, lab, health=healths) if logs else branches,
            )
            state.lab(tier.name, lab).over_committed = allocation.over_committed
            results.append({
                "lab": lab, "ok": True, "allocation": dict(allocation.quotas),
                "reserved_bytes": allocation.reserved,
                "changed": bool(logs),
                "over_committed": allocation.over_committed,
                "over_committed_changed": allocation.over_committed != was_over,
                "warnings": list(allocation.warnings), "logs": logs,
            })
        except (StorageError, zfs.ZfsError) as exc:
            results.append({"lab": lab, "ok": False, "error": str(exc)})
    state.save()
    return {"tier": tier_name, "health": health, "labs": results}


def reconcile_mounts(cfg: AgentConfig) -> dict[str, Any]:
    """Bring every tier's ZFS roots and per-lab mergerfs mounts up. Idempotent.

    This is what the ``lab-storage-mounts.service`` unit runs at boot (ordered after ZFS import/
    mount and before Docker), and what the agent runs on start. It never invents a branch: a lab
    whose pool is missing simply gets a union over the branches that ARE mounted, and a lab with no
    mounted branch at all is left unmounted and reported, not papered over with a root-filesystem
    directory.
    """
    report: dict[str, Any] = {"tiers": {}, "mounted": [], "degraded": [], "failed": []}
    state = _state(cfg)
    for tier in cfg.storage.tiers():
        if not tier.is_zfs_owned:
            report["tiers"][tier.name] = {"backend": tier.backend, "skipped": True}
            continue
        ensure_tier_roots(tier)
        health, healths = tier_health(tier)
        report["tiers"][tier.name] = {
            "backend": tier.backend,
            "health": health,
            "pools": [h.to_dict() for h in healths],
        }
        if not tier.uses_mergerfs:
            continue
        # Labs known from live ZFS, unioned with the ones the state file remembers. The state file
        # is what lets a lab whose pools have ALL disappeared still be found — and therefore have
        # its now-dangling union torn down instead of left serving empty directories.
        known_labs = sorted(set(discover_labs(tier)) | set(state.labs_in_tier(tier.name)))
        for lab in known_labs:
            branches = observe_branches(tier, lab, health=healths)
            paths = [b.path for b in branches if b.present]
            target = tier.logical_mount(lab)
            if not paths:
                # Every branch is gone. Tear the union DOWN rather than leave it serving empty
                # root-filesystem directories, which is how a missing disk would silently turn into
                # data written to /.
                mfs.unmount(target)
                report["failed"].append(
                    {"tier": tier.name, "lab": lab,
                     "error": "no mounted branch; logical mount left down on purpose"}
                )
                continue
            try:
                if mfs.is_mergerfs_mount(target):
                    _converge_live_branches(tier, lab, target, paths, report)
                else:
                    mfs.mount(tier, lab, paths)
                    report["mounted"].append(target)
            except mfs.MergerfsError as exc:
                report["failed"].append({"tier": tier.name, "lab": lab, "error": str(exc)})
                continue
            if len(paths) < len(branches):
                report["degraded"].append(
                    {"tier": tier.name, "lab": lab,
                     "missing": [b.pool for b in branches if not b.present]}
                )
            _record(state, tier, lab, None, branches)
    state.save()
    return report


def _converge_live_branches(
    tier: TierConfig, lab: str, target: str, paths: list[str], report: dict[str, Any]
) -> None:
    """Make a live union's branch list match reality, without remounting where possible.

    Both directions matter:

    * a branch that came back is ADDED, so the returning disk starts serving again;
    * a branch whose pool went away is REMOVED, because its mountpoint may still exist as an empty
      directory on the root filesystem and mergerfs would happily create files in it.
    """
    live = mfs.current_branches(target)
    wanted = set(paths)
    for path in live:
        if path in wanted:
            continue
        result = mfs.remove_branch_live(target, path)
        if result.ok:
            report["mounted"].append(f"{target} (-{path})")
        else:
            mfs.remount(tier, lab, paths)
            report["degraded"].append(
                {"tier": tier.name, "lab": lab, "restart_required": True,
                 "detail": f"could not drop the dead branch {path} from {target}; remounted"}
            )
            return
    for path in paths:
        if path in live:
            continue
        result = mfs.attach_branch(tier, lab, path, paths)
        report["mounted"].append(f"{target} (+{path})")
        if result.remounted:
            report["degraded"].append(
                {"tier": tier.name, "lab": lab, "restart_required": True,
                 "detail": result.detail}
            )


# --------------------------------------------------------------------------- reporting


def collect_usage(cfg: AgentConfig) -> dict[str, dict[str, TierUsage]]:
    """Every lab's per-tier usage, from one ``zfs list -r`` per pool (cheap at any scale).

    Returns ``{lab: {tier: TierUsage}}``. Per-student child datasets are handled separately by
    ``collect_student_usage`` so the lab-level number is never double-counted.
    """
    out: dict[str, dict[str, TierUsage]] = {}
    state = _state(cfg)
    for tier in cfg.storage.tiers():
        if not tier.is_zfs_owned:
            continue
        healths = {h.pool: h for h in tier_health(tier)[1]}
        rows = _tier_rows(tier)
        for lab, per_pool in rows.items():
            branches: list[BranchObservation] = []
            for pool in tier.pools:
                info = healths.get(pool)
                usage = per_pool.get(pool)
                present = usage is not None and info is not None and info.usable
                branches.append(BranchObservation(
                    pool=pool,
                    dataset=tier.branch_dataset(pool, lab),
                    path=tier.branch_mount(pool, lab),
                    present=bool(present),
                    used=usage.used_bytes if usage else 0,
                    quota=usage.quota_bytes if usage else None,
                    available=usage.available_bytes if usage else None,
                    pool_free=info.free_bytes if info else 0,
                    pool_size=info.size_bytes if info else 0,
                    pool_usable=bool(info and info.usable),
                ))
            record = state.lab_or_none(tier.name, lab)
            configured = record.configured_quota_bytes if record else None
            usage_agg = aggregate(tier.name, lab, branches, configured_quota=configured)
            # Quota still owned by branches whose POOL is currently gone. Derived from the live
            # observation plus the last recorded allocation, so it is correct even if the state file
            # has not been rewritten since the disk disappeared.
            known = record.branches if record else {}
            usage_agg.reserved_bytes = sum(
                max(known[b.pool].quota_bytes or 0, known[b.pool].used_bytes or 0)
                for b in branches
                if not b.pool_usable and b.pool in known
                and known[b.pool].state != BRANCH_REMOVED
            )
            out.setdefault(lab, {})[tier.name] = usage_agg
    return out


def collect_student_usage(cfg: AgentConfig) -> dict[str, dict[str, dict[str, TierUsage]]]:
    """Per-student ZFS usage where per-student quota datasets exist.

    Shape: ``{lab: {user: {tier: TierUsage}}}``, each entry already summed across branches.
    """
    out: dict[str, dict[str, dict[str, TierUsage]]] = {}
    for tier in cfg.storage.tiers():
        if not tier.is_zfs_owned:
            continue
        healths = {h.pool: h for h in tier_health(tier)[1]}
        for lab, users in _tier_student_rows(tier).items():
            for user, per_pool in users.items():
                branches = []
                for pool in tier.pools:
                    info = healths.get(pool)
                    usage = per_pool.get(pool)
                    branches.append(BranchObservation(
                        pool=pool,
                        dataset=f"{tier.branch_dataset(pool, lab)}/{user}",
                        path=f"{tier.branch_mount(pool, lab)}/{user}",
                        present=usage is not None and info is not None and info.usable,
                        used=usage.used_bytes if usage else 0,
                        quota=usage.quota_bytes if usage else None,
                        available=usage.available_bytes if usage else None,
                        pool_free=info.free_bytes if info else 0,
                        pool_size=info.size_bytes if info else 0,
                        pool_usable=bool(info and info.usable),
                    ))
                if not any(b.present for b in branches):
                    continue
                out.setdefault(lab, {}).setdefault(user, {})[tier.name] = aggregate(
                    tier.name, lab, branches
                )
    return out


def _parse_rows(tier: TierConfig) -> tuple[dict[str, dict[str, zfs.Usage]],
                                           dict[str, dict[str, dict[str, zfs.Usage]]]]:
    """One ``zfs list -r`` per pool, split into lab-level and per-student rows."""
    labs: dict[str, dict[str, zfs.Usage]] = {}
    students: dict[str, dict[str, dict[str, zfs.Usage]]] = {}
    for pool in tier.pools:
        root = tier.pool_root_dataset(pool)
        prefix = root + "/"
        for usage in zfs.list_usage(root):
            if not usage.dataset.startswith(prefix):
                continue
            rest = usage.dataset[len(prefix):].split("/")
            lab = rest[0]
            if not lab:
                continue
            if len(rest) == 1:
                labs.setdefault(lab, {})[pool] = usage
            elif len(rest) == 2 and rest[1] not in RESERVED_CHILDREN and USERNAME_RE.match(rest[1]):
                students.setdefault(lab, {}).setdefault(rest[1], {})[pool] = usage
    return labs, students


def _tier_rows(tier: TierConfig) -> dict[str, dict[str, zfs.Usage]]:
    return _parse_rows(tier)[0]


def _tier_student_rows(tier: TierConfig) -> dict[str, dict[str, dict[str, zfs.Usage]]]:
    return _parse_rows(tier)[1]


def inventory(cfg: AgentConfig, *, with_devices: bool = True) -> dict[str, Any]:
    """The whole node's storage picture, for the controller's storage UI."""
    state = _state(cfg)
    storage: StorageConfig = cfg.storage
    tier_reports: dict[str, Any] = {}
    for tier in storage.tiers():
        health, healths = tier_health(tier)
        tier_reports[tier.name] = {
            "backend": tier.backend,
            "mount_root": tier.mount_root,
            "branch_root": tier.branch_root if tier.uses_mergerfs else None,
            "dataset_prefix": tier.dataset_prefix,
            "smb_path": tier.smb_path,
            "health": health,
            "pools": [h.to_dict() for h in healths],
            "mergerfs": tier.mergerfs.to_dict(),
            "logical_capacity_bytes": sum(h.size_bytes for h in healths if h.usable),
            "logical_free_bytes": sum(h.free_bytes for h in healths if h.usable),
            "labs": sorted(state.labs.get(tier.name, {})),
        }
    pool_reports = [
        poolinv.inspect_pool(pool, tiers=storage.tiers_for_pool(pool)).to_dict()
        for pool in storage.owned_pools
    ]
    known = {p["name"] for p in pool_reports}
    for pool in zfs.list_pool_names():
        if pool not in known:
            pool_reports.append(poolinv.inspect_pool(pool, tiers=[]).to_dict())
    return {
        "config": storage.to_dict(),
        "tiers": tier_reports,
        "pools": pool_reports,
        "docker": {
            **storage.docker.to_dict(),
            "on_zfs": zfs.dataset_exists(storage.docker.dataset),
        },
        "devices": [d.to_dict() for d in poolinv.list_block_devices()] if with_devices else [],
        "state": state.to_dict(),
    }


def tier_summaries(cfg: AgentConfig) -> list[dict[str, Any]]:
    """Compact per-tier health for the heartbeat (the full inventory is far too big for 15 s)."""
    out = []
    for tier in cfg.storage.tiers():
        health, healths = tier_health(tier)
        out.append({
            "tier": tier.name,
            "backend": tier.backend,
            "health": health,
            "mount_root": tier.mount_root,
            "pools": [h.pool for h in healths],
            "unavailable_pools": [h.pool for h in healths if not h.usable],
        })
    return out


def validate_tier_name(name: Any) -> str:
    if name not in (TIER_FAST, TIER_COLD):
        raise StorageConfigError(f"unknown storage tier {name!r}")
    return name
