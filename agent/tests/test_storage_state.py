"""Persisted branch bookkeeping — what a missing branch still owns."""

from __future__ import annotations

from lab_agent.storage.state import (
    BRANCH_ACTIVE,
    BRANCH_MISSING,
    BRANCH_REMOVED,
    StorageState,
)

GB = 1024 ** 3
TB = 1024 ** 4


def state(tmp_path) -> StorageState:
    return StorageState(str(tmp_path / "storage-state.json"))


def test_roundtrip(tmp_path):
    s = state(tmp_path)
    s.lab("cold", "labA").configured_quota_bytes = 2 * TB
    s.observe_branch("cold", "labA", "cold1", present=True, pool_available=True,
                     quota_bytes=1 * TB, used_bytes=800 * GB, now_ms=5)
    s.record_pool("cold", "cold1", now_ms=5)
    s.save()

    loaded = StorageState.load(s.path)
    record = loaded.lab_or_none("cold", "labA")
    assert record.configured_quota_bytes == 2 * TB
    assert record.branches["cold1"].quota_bytes == 1 * TB
    assert record.branches["cold1"].state == BRANCH_ACTIVE
    assert loaded.pools["cold1"].tier == "cold"


def test_missing_state_file_loads_empty(tmp_path):
    loaded = StorageState.load(str(tmp_path / "nope.json"))
    assert loaded.pools == {} and loaded.labs == {}


def test_corrupt_state_file_loads_empty_rather_than_crashing(tmp_path):
    path = tmp_path / "storage-state.json"
    path.write_text("{ not json")
    assert StorageState.load(str(path)).labs == {}


def test_state_file_is_owner_only(tmp_path):
    s = state(tmp_path)
    s.record_pool("fast", "fast1", now_ms=1)
    s.save()
    assert (tmp_path / "storage-state.json").stat().st_mode & 0o777 == 0o600


def test_a_vanished_pool_marks_the_branch_missing_and_keeps_its_quota(tmp_path):
    s = state(tmp_path)
    s.observe_branch("cold", "labA", "cold1", present=True, pool_available=True,
                     quota_bytes=1 * TB, used_bytes=800 * GB, now_ms=1)
    s.observe_branch("cold", "labA", "cold1", present=False, pool_available=False,
                     quota_bytes=None, used_bytes=None, now_ms=2)
    branch = s.lab("cold", "labA").branches["cold1"]
    assert branch.state == BRANCH_MISSING
    # Crucially the numbers are NOT cleared: they are the reservation.
    assert branch.quota_bytes == 1 * TB
    assert branch.used_bytes == 800 * GB
    assert set(s.reserved_pools("cold", "labA")) == {"cold1"}


def test_an_absent_dataset_on_a_healthy_pool_is_not_a_missing_branch(tmp_path):
    """'The disk went away' and 'the dataset is not there' must not be confused."""
    s = state(tmp_path)
    s.observe_branch("cold", "labA", "cold1", present=True, pool_available=True,
                     quota_bytes=1 * TB, used_bytes=0, now_ms=1)
    s.observe_branch("cold", "labA", "cold1", present=False, pool_available=True,
                     quota_bytes=None, used_bytes=None, now_ms=2)
    assert "cold1" not in s.lab("cold", "labA").branches
    assert s.reserved_pools("cold", "labA") == {}


def test_an_admin_removal_outranks_a_later_observation(tmp_path):
    s = state(tmp_path)
    s.record_pool("cold", "cold1", now_ms=1)
    s.observe_branch("cold", "labA", "cold1", present=True, pool_available=True,
                     quota_bytes=1 * TB, used_bytes=0, now_ms=1)
    s.mark_pool_removed("cold1", now_ms=2)
    assert s.pools["cold1"].state == BRANCH_REMOVED
    branch = s.lab("cold", "labA").branches["cold1"]
    assert branch.state == BRANCH_REMOVED
    # A removed branch releases its reservation — that is the point of the admin action.
    assert branch.quota_bytes is None
    assert s.reserved_pools("cold", "labA") == {}
    # A later "the pool is gone" observation does not resurrect it as MISSING.
    s.observe_branch("cold", "labA", "cold1", present=False, pool_available=False,
                     quota_bytes=None, used_bytes=None, now_ms=3)
    assert s.lab("cold", "labA").branches["cold1"].state == BRANCH_REMOVED


def test_a_returning_pool_becomes_active_again(tmp_path):
    s = state(tmp_path)
    s.observe_branch("cold", "labA", "cold1", present=False, pool_available=False,
                     quota_bytes=None, used_bytes=None, now_ms=1)
    assert s.lab("cold", "labA").branches["cold1"].state == BRANCH_MISSING
    s.observe_branch("cold", "labA", "cold1", present=True, pool_available=True,
                     quota_bytes=1 * TB, used_bytes=42, now_ms=2)
    assert s.lab("cold", "labA").branches["cold1"].state == BRANCH_ACTIVE
    assert s.lab("cold", "labA").branches["cold1"].last_seen_ms == 2


def test_forget_lab_drops_only_that_lab(tmp_path):
    s = state(tmp_path)
    s.observe_branch("cold", "labA", "cold1", present=True, pool_available=True,
                     quota_bytes=1, used_bytes=0, now_ms=1)
    s.observe_branch("cold", "labB", "cold1", present=True, pool_available=True,
                     quota_bytes=1, used_bytes=0, now_ms=1)
    s.forget_lab("cold", "labA")
    assert s.labs_in_tier("cold") == ["labB"]


def test_pool_membership_has_stable_ids_and_survives_a_tier_move(tmp_path):
    """Pool membership must be explicit so future drain/replace/remove stays possible."""
    s = state(tmp_path)
    s.record_pool("cold", "cold1", now_ms=1)
    assert s.pools["cold1"].tier == "cold" and s.pools["cold1"].added_at_ms == 1
    s.record_pool("fast", "cold1", now_ms=9)
    assert s.pools["cold1"].tier == "fast" and s.pools["cold1"].added_at_ms == 9


def test_a_state_file_from_a_future_version_is_ignored(tmp_path):
    path = tmp_path / "storage-state.json"
    path.write_text('{"version": 999, "pools": [{"pool": "x", "tier": "cold"}]}')
    assert StorageState.load(str(path)).pools == {}
