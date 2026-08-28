"""Generic multi-pool storage: tier model, quota allocator, mergerfs + ZFS lifecycle.

A *tier* is a logical storage class a lab container sees at one stable path (``/fast/<lab>`` and
``/cold-storage/<lab>``). A tier is backed by one or more independent ZFS pools ("branches"); with
more than one branch the per-lab branches are unioned by a per-lab mergerfs mount so a single lost
pool never destroys the others. Hard quotas stay on the underlying ZFS datasets and are sharded
across branches so their sum never exceeds the lab's configured tier quota.

See ``model`` for the data model, ``quota`` for the (pure) allocator, ``state`` for the persisted
branch bookkeeping, ``pools`` for ZFS/device inventory, ``mergerfs`` for mount management, and
``service`` for the operations the dispatcher/CLI call.
"""

from .model import (  # noqa: F401
    BACKEND_MERGERFS,
    BACKEND_SMB,
    BACKEND_ZFS,
    DEFAULT_BRANCH_ROOT,
    DEFAULT_DATASET_PREFIX,
    TIER_COLD,
    TIER_FAST,
    DockerStorage,
    MergerfsOptions,
    StorageConfig,
    StorageConfigError,
    TierConfig,
    legacy_storage,
    validate_pool_name,
)
