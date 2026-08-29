"""Persisted per-branch storage bookkeeping.

The node must remember two things across reboots and across a disk going away:

1. **What each branch was allocated.** When a pool disappears we must NOT hand its quota to the
   survivors: the disk may come back holding 800 GB, and the lab would then be over its configured
   quota with no way to reconcile. The last known allocation is the reservation.
2. **Whether a branch is missing or intentionally removed.** "The dataset isn't there" means very
   different things in those two cases: the first must block destructive operations, the second is
   a completed admin action. Only an explicit removal clears a branch's record.

Stored as one small JSON file beside the agent's state DB, written atomically. It is a CACHE of
agent-observed facts plus admin decisions — the ZFS datasets themselves remain authoritative for
what actually exists, and ``reconcile`` re-derives the record from live ZFS on every pass.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from typing import Any

STATE_VERSION = 1

# Branch lifecycle. "active" and "missing" are observations; "removed" is an admin decision.
BRANCH_ACTIVE = "active"
BRANCH_MISSING = "missing"
BRANCH_REMOVED = "removed"


@dataclass
class BranchRecord:
    """One lab's dataset on one pool of one tier."""

    pool: str
    quota_bytes: int | None = None
    used_bytes: int | None = None
    state: str = BRANCH_ACTIVE
    last_seen_ms: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class LabTierRecord:
    configured_quota_bytes: int | None = None
    branches: dict[str, BranchRecord] = field(default_factory=dict)
    # Whether the last rebalance found this lab over-committed (more bytes already on disk than the
    # configured quota allows). Persisted so a SCHEDULED rebalance can report the transition once
    # instead of repeating an unchanged, admin-actionable condition on every run.
    over_committed: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "configured_quota_bytes": self.configured_quota_bytes,
            "branches": {p: b.to_dict() for p, b in sorted(self.branches.items())},
            "over_committed": self.over_committed,
        }


@dataclass
class PoolRecord:
    """Tier membership for one pool, so 'never configured' and 'drained + removed' stay distinct."""

    pool: str
    tier: str
    state: str = BRANCH_ACTIVE
    added_at_ms: int | None = None
    removed_at_ms: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class StorageState:
    """Load/mutate/save the storage bookkeeping file."""

    def __init__(self, path: str):
        self.path = path
        self.pools: dict[str, PoolRecord] = {}
        # tier -> lab -> LabTierRecord
        self.labs: dict[str, dict[str, LabTierRecord]] = {}

    # ------------------------------------------------------------------ io
    @classmethod
    def load(cls, path: str) -> StorageState:
        state = cls(path)
        try:
            with open(path, encoding="utf-8") as fh:
                raw = json.load(fh)
        except (OSError, json.JSONDecodeError):
            return state
        if not isinstance(raw, dict) or raw.get("version") != STATE_VERSION:
            return state
        for entry in raw.get("pools", []) or []:
            if isinstance(entry, dict) and isinstance(entry.get("pool"), str):
                state.pools[entry["pool"]] = PoolRecord(
                    pool=entry["pool"],
                    tier=str(entry.get("tier", "")),
                    state=str(entry.get("state", BRANCH_ACTIVE)),
                    added_at_ms=entry.get("added_at_ms"),
                    removed_at_ms=entry.get("removed_at_ms"),
                )
        for tier, labs in (raw.get("labs", {}) or {}).items():
            if not isinstance(labs, dict):
                continue
            for lab, record in labs.items():
                if not isinstance(record, dict):
                    continue
                branches: dict[str, BranchRecord] = {}
                for pool, branch in (record.get("branches", {}) or {}).items():
                    if isinstance(branch, dict):
                        branches[pool] = BranchRecord(
                            pool=pool,
                            quota_bytes=branch.get("quota_bytes"),
                            used_bytes=branch.get("used_bytes"),
                            state=str(branch.get("state", BRANCH_ACTIVE)),
                            last_seen_ms=branch.get("last_seen_ms"),
                        )
                state.labs.setdefault(tier, {})[lab] = LabTierRecord(
                    configured_quota_bytes=record.get("configured_quota_bytes"),
                    branches=branches,
                    over_committed=bool(record.get("over_committed", False)),
                )
        return state

    def save(self) -> None:
        payload = {
            "version": STATE_VERSION,
            "pools": [p.to_dict() for p in sorted(self.pools.values(), key=lambda p: p.pool)],
            "labs": {
                tier: {lab: rec.to_dict() for lab, rec in sorted(labs.items())}
                for tier, labs in sorted(self.labs.items())
            },
        }
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        tmp = f"{self.path}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2, sort_keys=True)
            os.replace(tmp, self.path)
        except OSError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    # ------------------------------------------------------------------ accessors
    def lab(self, tier: str, name: str) -> LabTierRecord:
        return self.labs.setdefault(tier, {}).setdefault(name, LabTierRecord())

    def lab_or_none(self, tier: str, name: str) -> LabTierRecord | None:
        return self.labs.get(tier, {}).get(name)

    def labs_in_tier(self, tier: str) -> list[str]:
        return sorted(self.labs.get(tier, {}))

    def forget_lab(self, tier: str, name: str) -> None:
        self.labs.get(tier, {}).pop(name, None)

    def record_pool(self, tier: str, pool: str, *, now_ms: int) -> PoolRecord:
        record = self.pools.get(pool)
        if record is None or record.tier != tier:
            record = PoolRecord(pool=pool, tier=tier, added_at_ms=now_ms)
            self.pools[pool] = record
        record.state = BRANCH_ACTIVE
        record.removed_at_ms = None
        return record

    def mark_pool_removed(self, pool: str, *, now_ms: int) -> None:
        """Record an ADMIN removal. Distinguishes 'drained + detached' from 'the disk vanished'."""
        record = self.pools.get(pool)
        if record is None:
            return
        record.state = BRANCH_REMOVED
        record.removed_at_ms = now_ms
        for labs in self.labs.values():
            for lab_record in labs.values():
                branch = lab_record.branches.get(pool)
                if branch is not None:
                    branch.state = BRANCH_REMOVED
                    branch.quota_bytes = None

    def reserved_pools(self, tier: str, lab: str) -> dict[str, BranchRecord]:
        """Branches of this lab that are neither active nor explicitly removed — i.e. missing, and
        therefore still holding their allocation."""
        record = self.lab_or_none(tier, lab)
        if record is None:
            return {}
        return {
            pool: branch
            for pool, branch in record.branches.items()
            if branch.state == BRANCH_MISSING
        }

    def observe_branch(
        self,
        tier: str,
        lab: str,
        pool: str,
        *,
        present: bool,
        pool_available: bool,
        quota_bytes: int | None,
        used_bytes: int | None,
        now_ms: int,
    ) -> BranchRecord | None:
        """Fold a live observation into the record.

        Three distinct cases, and conflating them is exactly the bug this file exists to prevent:

        * **present** — refresh the numbers.
        * **absent, pool gone** — mark MISSING and KEEP the last known quota, so
          ``reserved_for_missing`` holds that capacity back from the survivors. A REMOVED branch
          stays removed (an admin decision outranks an observation).
        * **absent, pool healthy** — the dataset genuinely is not there (never created, destroyed,
          or the disk was replaced with a fresh pool of the same name). There is nothing to reserve,
          so the record is dropped rather than being treated as a lost disk.
        """
        record = self.lab(tier, lab)
        branch = record.branches.get(pool)
        if present:
            if branch is None:
                branch = BranchRecord(pool=pool)
                record.branches[pool] = branch
            branch.state = BRANCH_ACTIVE
            branch.quota_bytes = quota_bytes
            branch.used_bytes = used_bytes
            branch.last_seen_ms = now_ms
            return branch
        if pool_available:
            if branch is not None and branch.state != BRANCH_REMOVED:
                record.branches.pop(pool, None)
                return None
            return branch
        if branch is None:
            branch = BranchRecord(pool=pool)
            record.branches[pool] = branch
        if branch.state != BRANCH_REMOVED:
            branch.state = BRANCH_MISSING
        return branch

    def to_dict(self) -> dict[str, Any]:
        return {
            "pools": [p.to_dict() for p in sorted(self.pools.values(), key=lambda p: p.pool)],
            "labs": {
                tier: {lab: rec.to_dict() for lab, rec in sorted(labs.items())}
                for tier, labs in sorted(self.labs.items())
            },
        }
