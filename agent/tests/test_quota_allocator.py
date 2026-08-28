"""The quota allocator: the piece that makes hard per-lab quotas survive sharding.

The whole point of these tests is the invariant pair:

    INV-1  sum(branch quota) + reserved(missing)  <=  configured tier quota
    INV-2  branch quota >= branch used

They are checked on hand-built scenarios AND, in ``test_invariants_hold_for_random_inputs``, on
several thousand pseudo-random configurations (fixed seed, so failures reproduce).
"""

from __future__ import annotations

import random

import pytest

from lab_agent.storage.quota import (
    QUOTA_GRANULARITY,
    Allocation,
    BranchState,
    QuotaStep,
    allocate,
    plan_steps,
    reserved_for_missing,
)

GB = 1024 ** 3
TB = 1024 ** 4


def branch(pool, *, used=0, quota=None, free=8 * TB, available=True):
    return BranchState(pool=pool, used=used, quota=quota, pool_free=free, available=available)


def check_invariants(result: Allocation, configured: int, branches: list[BranchState]) -> None:
    used = {b.pool: b.used for b in branches}
    for pool, quota in result.quotas.items():
        assert quota >= used[pool], f"{pool}: quota {quota} < used {used[pool]}"
    if not result.over_committed:
        assert result.total <= configured, (
            f"sum(branch quota)={result.assigned} + reserved={result.reserved} > {configured}"
        )


# --------------------------------------------------------------------------- initial split


def test_equal_initial_split_across_two_identical_pools():
    branches = [branch("cold1"), branch("cold2")]
    result = allocate(2 * TB, branches)
    assert result.quotas == {"cold1": 1 * TB, "cold2": 1 * TB}
    check_invariants(result, 2 * TB, branches)


def test_single_branch_gets_the_whole_quota():
    branches = [branch("cold1")]
    result = allocate(2 * TB, branches)
    assert result.quotas == {"cold1": 2 * TB}


def test_uneven_physical_pool_sizes_split_proportionally():
    """A 2 TB disk and a 6 TB disk should not each get half the quota."""
    branches = [branch("cold1", free=2 * TB), branch("cold2", free=6 * TB)]
    result = allocate(4 * TB, branches, min_headroom=0)
    assert result.quotas["cold2"] > result.quotas["cold1"]
    assert result.quotas["cold1"] + result.quotas["cold2"] == 4 * TB
    check_invariants(result, 4 * TB, branches)


def test_a_branch_is_never_promised_more_than_its_pool_can_hold():
    """cold1 physically has 500 GB left; it must not be handed a 2 TB quota."""
    branches = [branch("cold1", free=500 * GB), branch("cold2", free=8 * TB)]
    result = allocate(4 * TB, branches)
    assert result.quotas["cold1"] <= 500 * GB
    check_invariants(result, 4 * TB, branches)


def test_capacity_that_fits_nowhere_is_reported_not_hidden():
    branches = [branch("cold1", free=100 * GB), branch("cold2", free=100 * GB)]
    result = allocate(4 * TB, branches)
    assert result.assigned == 200 * GB
    assert result.unallocated == 4 * TB - 200 * GB
    assert any("physical free space" in w for w in result.warnings)


# --------------------------------------------------------------------------- redistribution


def test_unused_quota_moves_toward_the_branch_with_data():
    """The scenario from the design: 900 GB used on one branch, 100 GB on the other."""
    branches = [
        branch("b1", used=900 * GB, quota=1 * TB, free=7 * TB),
        branch("b2", used=100 * GB, quota=1 * TB, free=7 * TB),
    ]
    result = allocate(2 * TB, branches, min_headroom=0)
    assert result.quotas["b1"] + result.quotas["b2"] == 2 * TB
    # Both keep at least what they hold; the split is no longer forced to 50/50.
    check_invariants(result, 2 * TB, branches)
    assert result.quotas["b1"] >= 900 * GB and result.quotas["b2"] >= 100 * GB


def test_a_heavily_used_branch_keeps_its_data_when_quota_is_reallocated():
    branches = [
        branch("b1", used=1900 * GB, quota=2 * TB, free=100 * GB),
        branch("b2", used=0, quota=0, free=8 * TB),
    ]
    result = allocate(2 * TB, branches)
    assert result.quotas["b1"] >= 1900 * GB
    check_invariants(result, 2 * TB, branches)


def test_an_almost_empty_branch_still_gets_usable_headroom():
    """A brand-new empty branch must be writable even when its sibling is nearly full."""
    branches = [
        branch("b1", used=1900 * GB, quota=1950 * GB, free=6 * TB),
        branch("b2", used=0, free=8 * TB),
    ]
    result = allocate(2 * TB, branches, min_headroom=16 * GB)
    assert result.quotas["b2"] >= 16 * GB
    check_invariants(result, 2 * TB, branches)


def test_quota_cannot_shrink_below_used():
    branches = [branch("b1", used=1800 * GB, quota=2 * TB, free=1 * TB),
                branch("b2", used=100 * GB, quota=0, free=8 * TB)]
    result = allocate(1 * TB, branches)
    # Honouring the reduction would mean a quota below used, which ZFS refuses outright.
    assert result.quotas["b1"] == 1800 * GB
    assert result.over_committed is True
    assert any("already committed on disk" in w for w in result.warnings)


def test_configured_quota_increase_is_distributed():
    branches = [branch("b1", used=500 * GB, quota=1 * TB, free=7 * TB),
                branch("b2", used=500 * GB, quota=1 * TB, free=7 * TB)]
    result = allocate(4 * TB, branches)
    assert result.assigned == 4 * TB
    check_invariants(result, 4 * TB, branches)


def test_configured_quota_reduction_that_still_fits():
    branches = [branch("b1", used=100 * GB, quota=1 * TB, free=7 * TB),
                branch("b2", used=100 * GB, quota=1 * TB, free=7 * TB)]
    result = allocate(1 * TB, branches)
    assert result.assigned == 1 * TB
    assert result.over_committed is False
    check_invariants(result, 1 * TB, branches)


# --------------------------------------------------------------------------- adding a branch


def test_adding_a_branch_preserves_the_total_quota():
    """The lifecycle case: 2 TB on cold1, add cold2, total must STAY 2 TB (not become 4 TB)."""
    before = [branch("cold1", used=800 * GB, quota=2 * TB, free=7 * TB)]
    assert allocate(2 * TB, before).quotas == {"cold1": 2 * TB}

    after = [
        branch("cold1", used=800 * GB, quota=2 * TB, free=7 * TB),
        branch("cold2", used=0, quota=None, free=8 * TB),
    ]
    result = allocate(2 * TB, after)
    # Still 2 TB in total, not 4 TB. (Up to one granularity unit per branch is lost to rounding
    # down, which is deliberate: a rounding remainder must never push the sum OVER the quota.)
    assert sum(result.quotas.values()) <= 2 * TB
    assert sum(result.quotas.values()) >= 2 * TB - 2 * QUOTA_GRANULARITY
    assert result.quotas["cold1"] >= 800 * GB
    assert result.quotas["cold2"] > 0
    check_invariants(result, 2 * TB, after)


def test_adding_a_branch_to_three_pools_still_totals_the_configured_quota():
    branches = [branch(f"p{i}", used=100 * GB, free=8 * TB) for i in range(3)]
    result = allocate(3 * TB, branches)
    assert 3 * TB - 3 * QUOTA_GRANULARITY <= sum(result.quotas.values()) <= 3 * TB
    check_invariants(result, 3 * TB, branches)


# --------------------------------------------------------------------------- missing branches


def test_a_missing_branch_keeps_its_allocation():
    """cold1 vanishes holding 800 GB of a 1 TB allocation; cold2 must NOT jump to 2 TB."""
    branches = [
        branch("cold1", used=800 * GB, quota=1 * TB, available=False),
        branch("cold2", used=500 * GB, quota=1 * TB, free=7 * TB),
    ]
    result = allocate(2 * TB, branches)
    assert "cold1" not in result.quotas          # nothing is applied to a missing dataset
    assert result.reserved == 1 * TB             # its allocation is held back
    assert result.quotas["cold2"] == 1 * TB      # ...so the survivor does NOT grow
    check_invariants(result, 2 * TB, branches)


def test_a_missing_branch_reserves_at_least_what_it_holds():
    """Even with no recorded quota, a missing branch reserves the data known to be on it."""
    branches = [branch("cold1", used=800 * GB, quota=None, available=False),
                branch("cold2", free=7 * TB)]
    result = allocate(2 * TB, branches)
    assert result.reserved == 800 * GB
    assert result.quotas["cold2"] == 2 * TB - 800 * GB


def test_every_branch_missing_allocates_nothing():
    branches = [branch("cold1", used=1 * TB, quota=1 * TB, available=False),
                branch("cold2", used=1 * TB, quota=1 * TB, available=False)]
    result = allocate(2 * TB, branches)
    assert result.quotas == {}
    assert result.reserved == 2 * TB
    assert any("no branch of this tier is currently available" in w for w in result.warnings)


def test_reserved_for_missing_ignores_available_branches():
    branches = [branch("a", used=5, quota=10), branch("b", used=7, quota=9, available=False)]
    assert reserved_for_missing(branches) == 9


def test_reduced_configured_quota_below_the_missing_reservation():
    branches = [branch("cold1", used=1 * TB, quota=1 * TB, available=False),
                branch("cold2", used=100 * GB, quota=1 * TB, free=7 * TB)]
    result = allocate(512 * GB, branches)
    assert result.over_committed is True
    assert result.quotas["cold2"] == 100 * GB   # pinned at its used bytes; no data removed


# --------------------------------------------------------------------------- rounding / edges


def test_quotas_are_rounded_down_to_the_granularity():
    branches = [branch("a", free=8 * TB), branch("b", free=8 * TB)]
    result = allocate(3 * TB + 12345, branches)
    for quota in result.quotas.values():
        assert quota % QUOTA_GRANULARITY == 0
    assert result.assigned <= 3 * TB + 12345


def test_tiny_allocations_are_not_rounded_to_zero():
    """Rounding must never turn a real (if tiny) allocation into an unsettable zero quota."""
    branches = [branch("a", free=1000)]
    result = allocate(1000, branches)
    assert result.quotas["a"] == 1000


def test_zero_configured_quota_is_accepted_and_allocates_nothing():
    branches = [branch("a", free=8 * TB)]
    assert allocate(0, branches).quotas == {"a": 0}


def test_negative_configured_quota_is_rejected():
    with pytest.raises(ValueError):
        allocate(-1, [branch("a")])


def test_no_branches_at_all():
    result = allocate(1 * TB, [])
    assert result.quotas == {} and result.reserved == 0


# --------------------------------------------------------------------------- ordering of changes


def test_shrinks_are_planned_before_grows():
    """Never a moment where sum(branch quota) exceeds the configured quota."""
    allocation = Allocation(quotas={"a": 500, "b": 1500})
    steps = plan_steps(allocation, {"a": 1000, "b": 1000},
                       {"a": "p/a", "b": "p/b"})
    assert [s.pool for s in steps] == ["a", "b"]
    assert steps[0].is_shrink and not steps[1].is_shrink


def test_an_unlimited_dataset_counts_as_a_shrink_so_it_is_capped_first():
    allocation = Allocation(quotas={"a": 500, "b": 1500})
    steps = plan_steps(allocation, {"a": None, "b": 1000}, {"a": "p/a", "b": "p/b"})
    assert steps[0].pool == "a" and steps[0].is_shrink


def test_unchanged_quotas_produce_no_step():
    allocation = Allocation(quotas={"a": 1000, "b": 1000})
    assert plan_steps(allocation, {"a": 1000, "b": 1000}, {"a": "p/a", "b": "p/b"}) == []


def test_steps_skip_branches_without_a_dataset():
    allocation = Allocation(quotas={"a": 10, "gone": 20})
    steps = plan_steps(allocation, {"a": 1}, {"a": "p/a"})
    assert steps == [QuotaStep(pool="a", dataset="p/a", current=1, target=10)]


# --------------------------------------------------------------------------- property-style


def test_invariants_hold_for_random_inputs():
    """Property-style sweep: for every generated scenario, INV-1 and INV-2 must hold."""
    rng = random.Random(20260828)
    for _ in range(3000):
        count = rng.randint(1, 5)
        branches = [
            BranchState(
                pool=f"p{i}",
                used=rng.choice([0, rng.randrange(0, 4 * TB)]),
                quota=rng.choice([None, rng.randrange(0, 4 * TB)]),
                pool_free=rng.choice([0, rng.randrange(0, 8 * TB)]),
                available=rng.random() > 0.25,
            )
            for i in range(count)
        ]
        configured = rng.randrange(0, 16 * TB)
        headroom = rng.choice([0, 1 * GB, 16 * GB])
        result = allocate(configured, branches, min_headroom=headroom)
        check_invariants(result, configured, branches)
        # A missing branch never receives an allocation.
        missing = {b.pool for b in branches if not b.available}
        assert not (missing & set(result.quotas))
        # Present branches always get exactly one entry.
        assert set(result.quotas) == {b.pool for b in branches if b.available}


def test_over_commitment_only_happens_when_used_exceeds_the_configured_quota():
    rng = random.Random(7)
    for _ in range(2000):
        branches = [
            BranchState(pool=f"p{i}", used=rng.randrange(0, 2 * TB),
                        quota=rng.randrange(0, 2 * TB), pool_free=rng.randrange(0, 4 * TB),
                        available=rng.random() > 0.2)
            for i in range(rng.randint(1, 4))
        ]
        configured = rng.randrange(0, 8 * TB)
        result = allocate(configured, branches)
        if result.over_committed:
            floor = sum(b.used for b in branches if b.available) + reserved_for_missing(branches)
            assert floor > configured
