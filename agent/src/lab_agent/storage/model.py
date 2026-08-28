"""Storage tier data model + config parsing/validation.

There are exactly two logical tiers, because a lab container mounts exactly two paths:

    fast -> /fast/<lab>          -> container /home
    cold -> /cold-storage/<lab>  -> container /cold-storage

Each tier picks a backend:

    zfs       one local ZFS pool; the lab dataset mounts directly at <mount_root>/<lab>.
    mergerfs  N independent local ZFS pools; each lab gets one dataset per pool, mounted out
              of the way under <branch_root>, unioned by a per-lab mergerfs mount at
              <mount_root>/<lab>.
    smb       (cold only) an externally-owned CIFS mount; this node is a pure client.

The dataset/mount layout is fully derived from the tier config, so nothing else in the agent has to
know how many pools a tier has:

    dataset       <pool>/<dataset_prefix>/<lab>              fast1/labs/labA
    branch mount  <branch_root>/<pool>/<prefix>/<lab>        /mnt/lab-storage/fast1/labs/labA
    logical mount <mount_root>/<lab>                         /fast/labA

On the single-pool ``zfs`` backend the branch mount *is* the logical mount, which is exactly
the pre-multi-pool layout — so existing installations keep working untouched.

The agent runs as root and every one of these values can reach a subprocess argv, so all names and
paths are validated here, once, with allow-lists. Nothing is ever interpolated into a shell string.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field, replace
from typing import Any

TIER_FAST = "fast"
TIER_COLD = "cold"
TIER_NAMES = (TIER_FAST, TIER_COLD)

BACKEND_ZFS = "zfs"
BACKEND_MERGERFS = "mergerfs"
BACKEND_SMB = "smb"
FAST_BACKENDS = (BACKEND_ZFS, BACKEND_MERGERFS)
COLD_BACKENDS = (BACKEND_ZFS, BACKEND_MERGERFS, BACKEND_SMB)

DEFAULT_FAST_POOL = "fast"
DEFAULT_COLD_POOL = "slow"
DEFAULT_FAST_MOUNT_ROOT = "/fast"
DEFAULT_COLD_MOUNT_ROOT = "/cold-storage"
# Backing ZFS datasets for a mergerfs tier mount HERE, deliberately outside anything a container
# ever sees, so a container path can never resolve to one specific branch.
DEFAULT_BRANCH_ROOT = "/mnt/lab-storage"
DEFAULT_DATASET_PREFIX = "labs"

DEFAULT_DOCKER_DATA_ROOT = "/var/lib/docker"
DEFAULT_DOCKER_DATASET_NAME = "docker"
DEFAULT_DOCKER_QUOTA_GB = 1024

GIB = 1024 ** 3


class StorageConfigError(ValueError):
    """Invalid storage configuration (bad pool name, path, backend, option value, ...)."""


# --------------------------------------------------------------------------- validation

# ZFS pool names: start with a letter, then letters/digits/underscore/hyphen/period/colon.
POOL_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,62}$")
# Names ZFS itself reserves for vdev types; a pool may not be called any of these.
RESERVED_POOL_NAMES = frozenset({"log", "spare", "mirror", "raidz", "draid", "replacing"})
RESERVED_POOL_PREFIXES = ("raidz", "draid")
# Dataset path components below the pool (the per-tier prefix, e.g. "labs").
DATASET_COMPONENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$")
# Absolute host paths the agent may mount at / create under.
PATH_RE = re.compile(r"^(/[A-Za-z0-9][A-Za-z0-9._-]*)+$")


def validate_pool_name(name: Any) -> str:
    """Validate a ZFS pool name against ZFS's own rules (and reject anything argv-unsafe)."""
    if not isinstance(name, str) or not POOL_NAME_RE.match(name):
        raise StorageConfigError(f"invalid ZFS pool name {name!r}")
    lowered = name.lower()
    if lowered in RESERVED_POOL_NAMES or lowered.startswith(RESERVED_POOL_PREFIXES):
        raise StorageConfigError(f"ZFS reserves the pool name {name!r}")
    # ZFS forbids pool names starting with "c" followed by a digit (legacy device naming).
    if len(name) > 1 and lowered[0] == "c" and name[1].isdigit():
        raise StorageConfigError(f"ZFS reserves pool names of the form c<number>: {name!r}")
    return name


def validate_dataset_component(value: Any, *, what: str) -> str:
    if not isinstance(value, str) or not DATASET_COMPONENT_RE.match(value):
        raise StorageConfigError(f"invalid {what} {value!r}")
    return value


def validate_path(value: Any, *, what: str, allow_root: bool = False) -> str:
    """An absolute, normalized, traversal-free host path."""
    if not isinstance(value, str) or not value.startswith("/"):
        raise StorageConfigError(f"{what} must be an absolute path, got {value!r}")
    cleaned = os.path.normpath(value.rstrip("/") or "/")
    if cleaned == "/" and not allow_root:
        raise StorageConfigError(f"{what} may not be the filesystem root")
    if cleaned != (value.rstrip("/") or "/"):
        raise StorageConfigError(f"{what} must be a normalized path, got {value!r}")
    if not PATH_RE.match(cleaned):
        raise StorageConfigError(f"{what} contains unsupported characters: {value!r}")
    return cleaned


def _positive_int(value: Any, *, what: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise StorageConfigError(f"{what} must be an integer >= {minimum}, got {value!r}")
    return value


# --------------------------------------------------------------------------- mergerfs options

# Only these mergerfs policy values are accepted. Advanced options are modelled as STRUCTURED
# settings with allow-listed values rather than free text, so a controller-supplied string can never
# turn into an arbitrary root mount option (or a `-o` injection) on the node.
CREATE_POLICIES = ("mfs", "epmfs", "lfs", "eplfs", "pfrd", "rand", "msplfs", "epall", "ff")
ACTION_POLICIES = ("epall", "all", "epff", "ff", "epmfs")
SEARCH_POLICIES = ("ff", "newest", "epff", "all")
MOVEONENOSPC_POLICIES = ("mfs", "pfrd", "lfs", "false")
CACHE_FILES_MODES = ("off", "partial", "full", "auto-full", "per-process", "libfuse")

# 50 GiB of slack before a branch stops being chosen for NEW files. Large enough that a branch never
# fills to the point where mergerfs has to fall back mid-write, small enough not to strand capacity.
DEFAULT_MINFREESPACE = 50 * GIB


@dataclass(frozen=True)
class MergerfsOptions:
    """Structured, allow-listed mergerfs mount options.

    Defaults chosen for this workload (student home directories + bulk cold data on quota'd ZFS
    branches):

    * ``category.create=mfs`` — a new file lands on the branch with the most free space, which with
      per-branch ZFS quotas means "the branch with the most remaining quota". Spreads writes without
      splitting a single file across disks.
    * ``moveonenospc=mfs`` — when a write fails with ENOSPC/EDQUOT (a branch hitting its ZFS quota),
      mergerfs relocates the open file to the branch with the most free space and retries, so one
      exhausted branch does not fail a write another branch could accept.
    * ``minfreespace`` — branches below this are skipped by the create policy.
    * ``cache.files=partial`` + ``dropcacheonclose=true`` — page cache is required for shared mmap
      (compilers, Python, editors all use it); dropping the cache on close avoids double-caching the
      same data in FUSE and in ZFS's ARC.
    * ``allow_other`` — students and the lab container are not root, so they must be able to
      traverse the mount.

    ``use_ino`` is deliberately NOT passed: mergerfs removed the option in 2.35 (inode calculation
    is always enabled and is controlled by ``inodecalc``, whose default ``hybrid-hash`` is stable
    for our layout).
    """

    create_policy: str = "mfs"
    action_policy: str = "epall"
    search_policy: str = "ff"
    moveonenospc: str = "mfs"
    minfreespace_bytes: int = DEFAULT_MINFREESPACE
    cache_files: str = "partial"
    dropcacheonclose: bool = True
    allow_other: bool = True

    def validate(self) -> MergerfsOptions:
        def _enum(value: Any, allowed: tuple[str, ...], what: str) -> None:
            if value not in allowed:
                raise StorageConfigError(
                    f"{what} must be one of {', '.join(allowed)}; got {value!r}"
                )

        _enum(self.create_policy, CREATE_POLICIES, "mergerfs create policy")
        _enum(self.action_policy, ACTION_POLICIES, "mergerfs action policy")
        _enum(self.search_policy, SEARCH_POLICIES, "mergerfs search policy")
        _enum(self.moveonenospc, MOVEONENOSPC_POLICIES, "mergerfs moveonenospc")
        _enum(self.cache_files, CACHE_FILES_MODES, "mergerfs cache.files")
        _positive_int(self.minfreespace_bytes, what="mergerfs minfreespace", minimum=0)
        if not isinstance(self.dropcacheonclose, bool) or not isinstance(self.allow_other, bool):
            raise StorageConfigError("mergerfs dropcacheonclose/allow_other must be booleans")
        return self

    def option_string(self, *, fsname: str) -> str:
        """The single ``-o`` value passed to mergerfs. Every part is an allow-listed constant or a
        validated integer/fsname, so this string is safe to hand to argv (never a shell)."""
        parts = [
            f"category.create={self.create_policy}",
            f"category.action={self.action_policy}",
            f"category.search={self.search_policy}",
            f"moveonenospc={self.moveonenospc}",
            f"minfreespace={int(self.minfreespace_bytes)}",
            f"cache.files={self.cache_files}",
            f"dropcacheonclose={'true' if self.dropcacheonclose else 'false'}",
            f"fsname={fsname}",
        ]
        if self.allow_other:
            parts.insert(0, "allow_other")
        return ",".join(parts)

    def to_dict(self) -> dict[str, Any]:
        return {
            "create_policy": self.create_policy,
            "action_policy": self.action_policy,
            "search_policy": self.search_policy,
            "moveonenospc": self.moveonenospc,
            "minfreespace_bytes": self.minfreespace_bytes,
            "cache_files": self.cache_files,
            "dropcacheonclose": self.dropcacheonclose,
            "allow_other": self.allow_other,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> MergerfsOptions:
        data = data or {}
        unknown = set(data) - set(cls().to_dict())
        if unknown:
            raise StorageConfigError(
                f"unknown mergerfs option(s): {', '.join(sorted(unknown))}"
            )
        return cls(**{**cls().to_dict(), **data}).validate()


# --------------------------------------------------------------------------- tier

# mergerfs "fsname" is what `df`/`findmnt` shows. Keep it descriptive and argv-safe.
_FSNAME_UNSAFE = re.compile(r"[^A-Za-z0-9_.-]+")


@dataclass(frozen=True)
class TierConfig:
    """One logical storage tier and the pools backing it."""

    name: str
    backend: str
    pools: tuple[str, ...] = ()
    mount_root: str = DEFAULT_FAST_MOUNT_ROOT
    branch_root: str = DEFAULT_BRANCH_ROOT
    dataset_prefix: str = DEFAULT_DATASET_PREFIX
    mergerfs: MergerfsOptions = field(default_factory=MergerfsOptions)
    # SMB backend only: the active mountpoint of the owner's share.
    smb_path: str | None = None
    # Minimum quota headroom (bytes) each present branch should get above its current usage, so a
    # freshly added empty branch is immediately usable even when its sibling is nearly full.
    min_branch_headroom_bytes: int = 16 * GIB

    # -------------------------------------------------------------- validation
    def validate(self) -> TierConfig:
        if self.name not in TIER_NAMES:
            raise StorageConfigError(f"unknown storage tier {self.name!r}")
        allowed = FAST_BACKENDS if self.name == TIER_FAST else COLD_BACKENDS
        if self.backend not in allowed:
            raise StorageConfigError(
                f"{self.name} backend must be one of {', '.join(allowed)}; got {self.backend!r}"
            )
        validate_path(self.mount_root, what=f"{self.name} mount_root")
        validate_dataset_component(self.dataset_prefix, what=f"{self.name} dataset prefix")
        _positive_int(self.min_branch_headroom_bytes,
                      what=f"{self.name} min_branch_headroom_bytes")
        self.mergerfs.validate()

        if self.backend == BACKEND_SMB:
            if self.pools:
                raise StorageConfigError("an SMB tier owns no ZFS pools")
            validate_path(self.smb_path or self.mount_root, what=f"{self.name} smb path")
            return self

        if not self.pools:
            raise StorageConfigError(f"{self.name} tier requires at least one pool")
        seen: set[str] = set()
        for pool in self.pools:
            validate_pool_name(pool)
            if pool in seen:
                raise StorageConfigError(f"pool {pool!r} listed twice in the {self.name} tier")
            seen.add(pool)
        if self.backend == BACKEND_ZFS and len(self.pools) > 1:
            raise StorageConfigError(
                f"the {self.name} tier has {len(self.pools)} pools but backend 'zfs' supports "
                "exactly one — use backend 'mergerfs' to union several pools"
            )
        if self.backend == BACKEND_MERGERFS:
            validate_path(self.branch_root, what=f"{self.name} branch_root")
            if any(":" in pool for pool in self.pools):
                raise StorageConfigError(
                    f"{self.name} mergerfs pool names may not contain ':' because mergerfs uses "
                    "it as the branch-list separator"
                )
            if self.branch_root == self.mount_root or self.mount_root.startswith(
                self.branch_root.rstrip("/") + "/"
            ):
                raise StorageConfigError(
                    f"{self.name} mount_root must not live inside branch_root "
                    "(containers would then see a single branch directly)"
                )
        return self

    # -------------------------------------------------------------- predicates
    @property
    def is_zfs_owned(self) -> bool:
        """Whether this node owns real ZFS datasets for the tier (i.e. not an SMB client)."""
        return self.backend in FAST_BACKENDS

    @property
    def uses_mergerfs(self) -> bool:
        return self.backend == BACKEND_MERGERFS

    @property
    def cold_root(self) -> str:
        """Host root holding the per-lab directories, whichever backend is in use."""
        if self.backend == BACKEND_SMB:
            return (self.smb_path or self.mount_root).rstrip("/")
        return self.mount_root

    # -------------------------------------------------------------- layout
    def pool_root_dataset(self, pool: str) -> str:
        """The per-pool container dataset holding one lab dataset per lab (``fast1/labs``)."""
        return f"{validate_pool_name(pool)}/{self.dataset_prefix}"

    def pool_root_mount(self, pool: str) -> str:
        """Where ``pool_root_dataset`` is mounted."""
        if not self.uses_mergerfs:
            return self.mount_root
        return f"{self.branch_root}/{validate_pool_name(pool)}/{self.dataset_prefix}"

    def branch_dataset(self, pool: str, lab: str) -> str:
        return f"{self.pool_root_dataset(pool)}/{lab}"

    def branch_mount(self, pool: str, lab: str) -> str:
        return f"{self.pool_root_mount(pool)}/{lab}"

    def logical_mount(self, lab: str) -> str:
        return f"{self.mount_root}/{lab}"

    def fsname(self, lab: str) -> str:
        return _FSNAME_UNSAFE.sub("-", f"lab-{self.name}-{lab}")[:80]

    def with_pools(self, pools: tuple[str, ...]) -> TierConfig:
        """A copy of this tier backed by ``pools``; promotes zfs -> mergerfs past one pool."""
        backend = self.backend
        if backend == BACKEND_ZFS and len(pools) > 1:
            backend = BACKEND_MERGERFS
        return replace(self, pools=tuple(pools), backend=backend).validate()

    def to_dict(self) -> dict[str, Any]:
        return {
            "backend": self.backend,
            "pools": list(self.pools),
            "mount_root": self.mount_root,
            "branch_root": self.branch_root,
            "dataset_prefix": self.dataset_prefix,
            "mergerfs": self.mergerfs.to_dict(),
            "smb_path": self.smb_path,
            "min_branch_headroom_bytes": self.min_branch_headroom_bytes,
        }


# --------------------------------------------------------------------------- docker


@dataclass(frozen=True)
class DockerStorage:
    """Docker's data-root, which stays on a NATIVE ZFS dataset — never on mergerfs.

    Docker's ``zfs`` storage driver clones its data-root dataset once per image layer and per
    container, and maps ``--storage-opt size=`` onto the clone's ZFS ``quota`` property. Neither
    works through FUSE, so the Docker pool is configured independently of the fast lab tier (it may
    happen to be the same physical pool, which is the common single-NVMe case).
    """

    pool: str = DEFAULT_FAST_POOL
    dataset_name: str = DEFAULT_DOCKER_DATASET_NAME
    data_root: str = DEFAULT_DOCKER_DATA_ROOT
    quota_gb: int = DEFAULT_DOCKER_QUOTA_GB

    def validate(self) -> DockerStorage:
        validate_pool_name(self.pool)
        validate_dataset_component(self.dataset_name, what="docker dataset name")
        validate_path(self.data_root, what="docker data_root")
        _positive_int(self.quota_gb, what="docker quota_gb")
        return self

    @property
    def dataset(self) -> str:
        return f"{self.pool}/{self.dataset_name}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "pool": self.pool,
            "dataset": self.dataset_name,
            "data_root": self.data_root,
            "quota_gb": self.quota_gb,
        }


# --------------------------------------------------------------------------- whole-node config


@dataclass(frozen=True)
class StorageConfig:
    fast: TierConfig
    cold: TierConfig
    docker: DockerStorage

    def validate(self) -> StorageConfig:
        self.fast.validate()
        self.cold.validate()
        self.docker.validate()
        overlap = set(self.fast.pools) & set(self.cold.pools)
        if overlap:
            raise StorageConfigError(
                "a pool may back only one tier; shared: " + ", ".join(sorted(overlap))
            )
        def overlaps(left: str, right: str) -> bool:
            return (
                left == right
                or left.startswith(right.rstrip("/") + "/")
                or right.startswith(left.rstrip("/") + "/")
            )

        if overlaps(self.fast.mount_root, self.cold.mount_root):
            raise StorageConfigError("fast and cold tier mount roots must not overlap")
        for tier in self.tiers():
            if overlaps(self.docker.data_root, tier.mount_root):
                raise StorageConfigError(
                    f"docker data_root must not overlap the {tier.name} logical mount root"
                )
            if tier.uses_mergerfs and overlaps(tier.branch_root, self.docker.data_root):
                raise StorageConfigError(
                    f"docker data_root must not overlap the {tier.name} mergerfs branch root"
                )
            if (
                self.docker.pool in tier.pools
                and self.docker.dataset_name == tier.dataset_prefix
            ):
                raise StorageConfigError(
                    f"docker dataset {self.docker.dataset!r} collides with the {tier.name} "
                    "tier root dataset"
                )
        branch_roots = [tier.branch_root for tier in self.tiers() if tier.uses_mergerfs]
        for branch_root in branch_roots:
            for tier in self.tiers():
                if overlaps(branch_root, tier.mount_root):
                    raise StorageConfigError(
                        f"mergerfs branch root {branch_root!r} must not overlap the "
                        f"{tier.name} logical mount root"
                    )
        return self

    def tier(self, name: str) -> TierConfig:
        if name == TIER_FAST:
            return self.fast
        if name == TIER_COLD:
            return self.cold
        raise StorageConfigError(f"unknown storage tier {name!r}")

    def tiers(self) -> tuple[TierConfig, ...]:
        return (self.fast, self.cold)

    def with_tier(self, tier: TierConfig) -> StorageConfig:
        if tier.name == TIER_FAST:
            return replace(self, fast=tier).validate()
        return replace(self, cold=tier).validate()

    @property
    def owned_pools(self) -> list[str]:
        """Every ZFS pool this node owns, in a stable order. These are the scrubbable pools; an SMB
        cold tier contributes none (the owner node scrubs that data)."""
        out: list[str] = []
        for pool in (*self.fast.pools, *self.cold.pools, self.docker.pool):
            if pool not in out:
                out.append(pool)
        return out

    def tiers_for_pool(self, pool: str) -> list[str]:
        """Which logical tiers a pool backs (``docker`` included), for the WebUI inventory."""
        out = [t.name for t in self.tiers() if pool in t.pools]
        if self.docker.pool == pool:
            out.append("docker")
        return out

    def to_dict(self) -> dict[str, Any]:
        return {
            "fast": self.fast.to_dict(),
            "cold": self.cold.to_dict(),
            "docker": self.docker.to_dict(),
        }


# --------------------------------------------------------------------------- construction


def legacy_storage(
    *,
    fast_pool: str = DEFAULT_FAST_POOL,
    slow_pool: str = DEFAULT_COLD_POOL,
    slow_backend: str = BACKEND_ZFS,
    slow_path: str | None = None,
    fast_mount_root: str = DEFAULT_FAST_MOUNT_ROOT,
    cold_mount_root: str = DEFAULT_COLD_MOUNT_ROOT,
    docker_pool: str | None = None,
    docker_dataset_name: str = DEFAULT_DOCKER_DATASET_NAME,
    docker_data_root: str = DEFAULT_DOCKER_DATA_ROOT,
    docker_quota_gb: int = DEFAULT_DOCKER_QUOTA_GB,
) -> StorageConfig:
    """Build the internal model from the pre-multi-pool scalar settings.

    This is both the compatibility shim for an existing ``config.toml`` and the ergonomic
    constructor for a plain single-pool node:

        fast_pool = "fast"  ->  storage.fast  = {backend: zfs, pools: ["fast"]}
        slow_pool = "slow"  ->  storage.cold  = {backend: zfs, pools: ["slow"]}
                            ->  storage.docker = {pool: "fast", dataset: "docker"}
    """
    fast = TierConfig(
        name=TIER_FAST,
        backend=BACKEND_ZFS,
        pools=(fast_pool,),
        mount_root=fast_mount_root,
    )
    if slow_backend == BACKEND_SMB:
        cold = TierConfig(
            name=TIER_COLD,
            backend=BACKEND_SMB,
            pools=(),
            mount_root=cold_mount_root,
            smb_path=(slow_path or DEFAULT_COLD_MOUNT_ROOT),
        )
    else:
        cold = TierConfig(
            name=TIER_COLD,
            backend=slow_backend,
            pools=(slow_pool,),
            mount_root=cold_mount_root,
        )
    docker = DockerStorage(
        pool=docker_pool or fast_pool,
        dataset_name=docker_dataset_name,
        data_root=docker_data_root,
        quota_gb=docker_quota_gb,
    )
    return StorageConfig(fast=fast, cold=cold, docker=docker).validate()


def default_storage() -> StorageConfig:
    return legacy_storage()


_TIER_KEYS = {
    "backend", "pools", "pool", "mount_root", "branch_root", "dataset_prefix",
    "mergerfs", "smb_path", "path", "min_branch_headroom_gb", "min_branch_headroom_bytes",
}
_DOCKER_KEYS = {"pool", "dataset", "dataset_name", "data_root", "quota_gb"}


def _tier_from_table(name: str, table: dict[str, Any], *, default: TierConfig) -> TierConfig:
    unknown = set(table) - _TIER_KEYS
    if unknown:
        raise StorageConfigError(
            f"[storage.{name}] has unknown key(s): {', '.join(sorted(unknown))}"
        )
    pools_value = table.get("pools", table.get("pool"))
    if pools_value is None:
        pools: tuple[str, ...] = default.pools
    elif isinstance(pools_value, str):
        pools = (pools_value,)
    elif isinstance(pools_value, list) and all(isinstance(p, str) for p in pools_value):
        pools = tuple(pools_value)
    else:
        raise StorageConfigError(f"[storage.{name}].pools must be a string or list of strings")

    backend = table.get("backend", default.backend)
    if not isinstance(backend, str):
        raise StorageConfigError(f"[storage.{name}].backend must be a string")
    if backend == BACKEND_SMB:
        pools = ()

    mergerfs_table = table.get("mergerfs")
    if mergerfs_table is not None and not isinstance(mergerfs_table, dict):
        raise StorageConfigError(f"[storage.{name}.mergerfs] must be a table")
    headroom_gb = table.get("min_branch_headroom_gb")
    headroom_bytes = table.get("min_branch_headroom_bytes")
    if headroom_gb is not None and headroom_bytes is not None:
        raise StorageConfigError(
            f"[storage.{name}] may set only one of min_branch_headroom_gb/bytes"
        )
    if headroom_bytes is not None:
        headroom = _positive_int(
            headroom_bytes, what=f"[storage.{name}].min_branch_headroom_bytes"
        )
    elif headroom_gb is not None:
        headroom = _positive_int(
            headroom_gb, what=f"[storage.{name}].min_branch_headroom_gb"
        ) * GIB
    else:
        headroom = default.min_branch_headroom_bytes
    return TierConfig(
        name=name,
        backend=backend,
        pools=pools,
        mount_root=table.get("mount_root", default.mount_root),
        branch_root=table.get("branch_root", default.branch_root),
        dataset_prefix=table.get("dataset_prefix", default.dataset_prefix),
        mergerfs=MergerfsOptions.from_dict(mergerfs_table) if mergerfs_table else default.mergerfs,
        smb_path=table.get("smb_path", table.get("path", default.smb_path)),
        min_branch_headroom_bytes=headroom,
    ).validate()


def storage_from_toml(data: dict[str, Any], *, legacy: StorageConfig) -> StorageConfig:
    """Parse the ``[storage.*]`` tables, falling back per-tier to the legacy-derived config.

    Mixing is allowed and useful during migration: a config may keep ``fast_pool = "fast"`` and add
    only ``[storage.cold]`` with two pools.
    """
    if not isinstance(data, dict):
        raise StorageConfigError("[storage] must be a table")
    unknown = set(data) - {TIER_FAST, TIER_COLD, "docker"}
    if unknown:
        raise StorageConfigError(f"[storage] has unknown section(s): {', '.join(sorted(unknown))}")
    fast = _tier_from_table(TIER_FAST, data.get(TIER_FAST, {}) or {}, default=legacy.fast)
    cold = _tier_from_table(TIER_COLD, data.get(TIER_COLD, {}) or {}, default=legacy.cold)

    docker_table = data.get("docker", {}) or {}
    if not isinstance(docker_table, dict):
        raise StorageConfigError("[storage.docker] must be a table")
    unknown = set(docker_table) - _DOCKER_KEYS
    if unknown:
        raise StorageConfigError(
            f"[storage.docker] has unknown key(s): {', '.join(sorted(unknown))}"
        )
    # An explicit [storage.fast].pools with no [storage.docker].pool keeps Docker on the FIRST fast
    # pool, which is where it already lives on every pre-multi-pool node.
    docker_default_pool = legacy.docker.pool if not data.get(TIER_FAST) else fast.pools[0]
    docker = DockerStorage(
        pool=docker_table.get("pool", docker_default_pool),
        dataset_name=docker_table.get("dataset", docker_table.get(
            "dataset_name", legacy.docker.dataset_name)),
        data_root=docker_table.get("data_root", legacy.docker.data_root),
        quota_gb=docker_table.get("quota_gb", legacy.docker.quota_gb),
    ).validate()
    return StorageConfig(fast=fast, cold=cold, docker=docker).validate()
