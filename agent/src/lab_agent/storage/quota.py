"""Sharding a lab's logical tier quota across its ZFS branches.

mergerfs has no quota mechanism of its own, so the hard limit stays where it always was: a ZFS
``quota`` property on each branch dataset. The job of this module is to split ONE configured logical
quota across N branches such that:

    INV-1  sum(branch quota) + reserved(missing branches)  <=  configured tier quota
    INV-2  branch quota >= branch used            (ZFS itself rejects anything else)
    INV-3  a branch that is currently missing keeps its previous allocation, untouched

INV-2 can conflict with INV-1 when an administrator lowers a lab's quota below what is already
on disk, or when a branch disappears while holding data. ZFS physically cannot set a quota below
a dataset's used bytes, so INV-2 wins and the result is flagged ``over_committed``: the caller
reports it rather than pretending the reduction took effect. No data is deleted to satisfy a
number.

Everything here is a pure function over plain dataclasses — no ZFS, no filesystem — so the
invariants are cheap to test exhaustively (see tests/test_quota_allocator.py).

Quota moves, files do not. Rebalancing only rewrites ZFS ``quota`` properties (instant, free);
existing files stay on the branch that already holds them.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Quotas are rounded down to this granularity so the numbers stay legible and a rounding remainder
# can never push the sum over budget.
QUOTA_GRANULARITY = 1024 * 1024  # 1 MiB


@dataclass(frozen=True)
class BranchState:
    """One branch of one lab's tier, as observed right now."""

    pool: str
    # Bytes the lab's dataset currently occupies on this branch.
    used: int = 0
    # The ZFS quota currently set on the branch dataset (None = unlimited / not yet created).
    quota: int | None = None
    # Free bytes physically available in the backing pool for this dataset to grow into. This is the
    # pool's free space, NOT the dataset's quota headroom.
    pool_free: int = 0
    # False when the pool/dataset is not imported+mounted right now (a pulled or failed disk).
    available: bool = True

    @property
    def floor(self) -> int:
        """The lowest quota ZFS would accept for this branch."""
        return max(0, self.used)

    @property
    def ceiling(self) -> int:
        """The highest quota worth setting: anything above this cannot be filled anyway."""
        return self.floor + max(0, self.pool_free)


@dataclass(frozen=True)
class Allocation:
    """Target quotas for the branches that are present, plus what the missing ones still hold."""

    quotas: dict[str, int] = field(default_factory=dict)
    # Sum of the allocations still owned by branches that are currently missing. Held back from the
    # budget so a returning disk does not push the lab over its configured quota.
    reserved: int = 0
    # Budget that could not be handed to any branch because no branch has the physical room.
    unallocated: int = 0
    over_committed: bool = False
    warnings: tuple[str, ...] = ()

    @property
    def assigned(self) -> int:
        return sum(self.quotas.values())

    @property
    def total(self) -> int:
        """Everything the lab is committed to across present + missing branches."""
        return self.assigned + self.reserved


def _round_down(value: int) -> int:
    return (value // QUOTA_GRANULARITY) * QUOTA_GRANULARITY


def reserved_for_missing(branches: list[BranchState]) -> int:
    """What currently-missing branches still own.

    A missing branch keeps whatever it was last allocated (or at least what it is known to hold),
    so the surviving branches are NOT handed its capacity. If the disk comes back with 800 GB on
    it, the lab is still inside its configured quota. Releasing that reservation is an explicit
    admin action (remove/replace/drain the pool), never an automatic consequence of a disk going
    away.
    """
    return sum(max(b.quota or 0, b.used) for b in branches if not b.available)


def allocate(
    configured: int,
    branches: list[BranchState],
    *,
    min_headroom: int = 0,
) -> Allocation:
    """Split ``configured`` bytes across the present branches of one lab tier.

    Strategy:

    1. Hold back what missing branches own (``reserved``); the rest is the budget.
    2. Give every present branch its floor (= bytes already on it). ZFS cannot go below this.
    3. Give every present branch up to ``min_headroom`` of usable slack, so a brand-new empty branch
       is immediately writable even when its sibling is nearly full.
    4. Water-fill the remaining slack in proportion to each branch's PHYSICAL room to grow
       (``pool_free``), capping each branch at ``used + pool_free`` and redistributing anything that
       does not fit. Capacity that fits nowhere is reported as ``unallocated`` rather than silently
       handed to a branch that cannot use it.

    Only ``pool`` names of present branches appear in the result; the caller applies them to the
    corresponding datasets.
    """
    if configured < 0:
        raise ValueError("configured quota must not be negative")
    warnings: list[str] = []
    present = [b for b in branches if b.available]
    missing = [b for b in branches if not b.available]
    reserved = reserved_for_missing(branches)
    if missing:
        warnings.append(
            f"{len(missing)} branch(es) unavailable ({', '.join(b.pool for b in missing)}); "
            f"{reserved} bytes of quota stay reserved for them"
        )
    if not present:
        return Allocation(
            quotas={}, reserved=reserved, unallocated=max(0, configured - reserved),
            over_committed=reserved > configured,
            warnings=(*warnings, "no branch of this tier is currently available"),
        )

    budget = configured - reserved
    floors = {b.pool: b.floor for b in present}
    floor_total = sum(floors.values())

    if budget <= floor_total:
        # Cannot honour the configured total without shrinking a quota below its used bytes, which
        # ZFS refuses. Pin each branch at exactly what it holds and say so loudly.
        over = floor_total + reserved > configured
        if over:
            warnings.append(
                f"configured quota {configured} is below the {floor_total + reserved} bytes "
                "already committed on disk; branches are pinned at their current usage "
                "(no data is removed)"
            )
        return Allocation(
            quotas=dict(floors), reserved=reserved, unallocated=0,
            over_committed=over, warnings=tuple(warnings),
        )

    slack = budget - floor_total
    room = {b.pool: max(0, b.ceiling - b.floor) for b in present}
    grants = {b.pool: 0 for b in present}

    # Step 3: guaranteed minimum headroom, smallest-room-first so a tiny branch is not starved by a
    # proportional split that rounds it to nothing.
    if min_headroom > 0:
        for pool in sorted(room, key=lambda p: room[p]):
            if slack <= 0:
                break
            give = min(min_headroom, room[pool], slack)
            grants[pool] += give
            room[pool] -= give
            slack -= give

    # Step 4: proportional water-filling of what is left.
    slack, unallocated_warning = _water_fill(grants, room, slack)
    if unallocated_warning:
        warnings.append(
            f"{slack} bytes of the configured quota cannot be allocated: no available branch has "
            "the physical free space to back it"
        )

    quotas = {pool: floors[pool] + grants[pool] for pool in floors}
    quotas = _round_to_budget(quotas, floors, budget)
    return Allocation(
        quotas=quotas,
        reserved=reserved,
        unallocated=max(0, budget - sum(quotas.values())),
        over_committed=False,
        warnings=tuple(warnings),
    )


def _water_fill(grants: dict[str, int], room: dict[str, int], slack: int) -> tuple[int, bool]:
    """Hand ``slack`` out in proportion to remaining ``room``, capping and redistributing.

    Mutates ``grants``/``room`` in place. Returns ``(leftover, hit_capacity_wall)``. Terminates
    because every iteration either strictly reduces ``slack`` or takes the greedy exit.
    """
    while slack > 0:
        open_pools = [p for p, r in room.items() if r > 0]
        if not open_pools:
            return slack, True
        total_room = sum(room[p] for p in open_pools)
        if slack >= total_room:
            # Everything on offer fits; fill every branch to its physical ceiling.
            for pool in open_pools:
                grants[pool] += room[pool]
                slack -= room[pool]
                room[pool] = 0
            continue
        # Largest room first, so integer truncation leaves the remainder with the branch best able
        # to absorb it.
        progressed = 0
        for pool in sorted(open_pools, key=lambda p: (-room[p], p)):
            share = min(room[pool], (slack * room[pool]) // total_room)
            grants[pool] += share
            room[pool] -= share
            progressed += share
        slack -= progressed
        if progressed == 0:
            # Truncation stalled the proportional pass (tiny slack); place the rest greedily.
            for pool in sorted(open_pools, key=lambda p: (-room[p], p)):
                give = min(room[pool], slack)
                grants[pool] += give
                room[pool] -= give
                slack -= give
            break
    return max(0, slack), slack > 0


def _round_to_budget(
    quotas: dict[str, int], floors: dict[str, int], budget: int
) -> dict[str, int]:
    """Round each quota down to the granularity, never below its floor, never above the budget.

    Values smaller than the granularity are kept EXACT rather than rounded to zero: a zero quota is
    not a limit ZFS accepts, and silently turning a tiny allocation into "nothing" would be a
    surprising way to lose a branch.
    """
    # round_down(value) <= value and floor <= value, so the max of the two never exceeds value.
    out = {
        pool: (max(floors[pool], _round_down(value)) if value >= QUOTA_GRANULARITY else value)
        for pool, value in quotas.items()
    }
    total = sum(out.values())
    if total <= budget:
        return out
    # Rounding a floor UP is impossible (floors are exact), so an overshoot can only come from a
    # floor that is itself not granularity-aligned. Trim the largest non-floor grants back.
    overshoot = total - budget
    for pool in sorted(out, key=lambda p: -(out[p] - floors[p])):
        if overshoot <= 0:
            break
        trim = min(overshoot, out[pool] - floors[pool])
        out[pool] -= trim
        overshoot -= trim
    return out


# --------------------------------------------------------------------------- applying safely


@dataclass(frozen=True)
class QuotaStep:
    """One ``zfs set quota=`` to perform, in a safe order."""

    pool: str
    dataset: str
    current: int | None
    target: int

    @property
    def is_shrink(self) -> bool:
        return self.current is None or self.target < self.current


def plan_steps(
    allocation: Allocation, current: dict[str, int | None], datasets: dict[str, str]
) -> list[QuotaStep]:
    """Order the quota changes so the committed total NEVER transiently exceeds the configured one.

    Shrinks (which free budget) run first, then grows (which spend it). A dataset with no quota at
    all counts as a shrink so an accidentally-unlimited dataset is capped before anything grows.
    """
    steps = [
        QuotaStep(pool=pool, dataset=datasets[pool], current=current.get(pool), target=target)
        for pool, target in allocation.quotas.items()
        if pool in datasets and current.get(pool) != target
    ]
    shrinks = sorted((s for s in steps if s.is_shrink), key=lambda s: s.pool)
    grows = sorted((s for s in steps if not s.is_shrink), key=lambda s: s.pool)
    return [*shrinks, *grows]
