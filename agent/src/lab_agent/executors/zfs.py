"""ZFS executor: create/destroy datasets, set/get quotas, read usage.

All quotas are bytes. Functions raise ZfsError on failure (the dispatcher catches it and reports a
structured failure). Quota changes are applied live with `zfs set quota=` — no remount/restart.
"""

from __future__ import annotations

from dataclasses import dataclass

from .base import CommandResult, run


class ZfsError(RuntimeError):
    pass


def _checked(res: CommandResult) -> CommandResult:
    if not res.ok:
        raise ZfsError(res.logs)
    return res


def dataset_exists(name: str) -> bool:
    return run(["zfs", "list", "-H", "-o", "name", name], timeout=20).ok


def create_dataset(
    name: str,
    *,
    quota_bytes: int | None = None,
    mountpoint: str | None = None,
    create_parents: bool = True,
    properties: dict[str, str] | None = None,
) -> None:
    """Create a dataset (idempotent). Optionally set a quota.

    The quota and mountpoint are passed as ``-o`` properties at CREATE time so a new branch dataset
    is never even momentarily unlimited, or momentarily mounted at the inherited (wrong) path. On an
    already-existing dataset they are applied live afterwards, which is what ZFS does anyway.
    """
    if quota_bytes is not None and int(quota_bytes) <= 0:
        raise ZfsError(
            f"refusing to create {name} with a non-positive quota ({quota_bytes}): ZFS has no "
            "zero quota, and an omitted quota would leave the dataset unlimited"
        )
    if not dataset_exists(name):
        args = ["zfs", "create"]
        if create_parents:
            args.append("-p")
        for key, value in sorted((properties or {}).items()):
            args += ["-o", f"{key}={value}"]
        if quota_bytes is not None:
            args += ["-o", f"quota={int(quota_bytes)}"]
        if mountpoint is not None:
            args += ["-o", f"mountpoint={mountpoint}"]
        args.append(name)
        _checked(run(args, timeout=60))
        return
    for key, value in sorted((properties or {}).items()):
        set_property(name, key, value)
    if quota_bytes is not None:
        set_quota(name, quota_bytes)
    if mountpoint is not None and get_mountpoint(name) != mountpoint:
        # Only re-assert a mountpoint that actually differs. `zfs set mountpoint` unmounts and
        # remounts the dataset, so re-applying the value it already has fails with "cannot
        # unmount ...: pool or dataset is busy" as soon as a child dataset is mounted beneath it
        # — which is exactly the state a tier root is in from the second lab onwards.
        set_property(name, "mountpoint", mountpoint)


def set_property(dataset: str, key: str, value: str) -> None:
    """Set one trusted ZFS property. Keys are internal constants, never user input."""
    _checked(run(["zfs", "set", f"{key}={value}", dataset], timeout=30))


def unmount(dataset: str) -> None:
    """Unmount a dataset. Idempotent: already-unmounted is success, not an error.

    Needed before moving a parent's mountpoint: ZFS cannot unmount a dataset while a child dataset
    is still mounted underneath it, and `zfs set mountpoint` always unmounts first.
    """
    res = run(["zfs", "unmount", dataset], timeout=30)
    if res.ok or "not currently mounted" in f"{res.stdout}{res.stderr}":
        return
    _checked(res)


def set_quota(dataset: str, quota_bytes: int | None) -> None:
    """Set (or clear, when None) the quota on a dataset. Applies live.

    ZFS has no concept of a zero quota (``quota=0`` is rejected; ``none`` means unlimited), so a
    non-positive byte count is a caller bug rather than something to pass through and have fail
    with an opaque ZFS message.
    """
    if quota_bytes is not None and int(quota_bytes) <= 0:
        raise ZfsError(
            f"refusing to set a non-positive quota ({quota_bytes}) on {dataset}: ZFS has no zero "
            "quota, and 'none' would mean unlimited"
        )
    value = "none" if quota_bytes is None else str(int(quota_bytes))
    _checked(run(["zfs", "set", f"quota={value}", dataset], timeout=30))


@dataclass
class Usage:
    dataset: str
    used_bytes: int
    quota_bytes: int | None
    available_bytes: int | None


def _parse_int(value: str) -> int | None:
    value = value.strip()
    if value in ("", "-", "none"):
        return None
    try:
        return int(value)
    except ValueError:
        return None


def get_usage(dataset: str) -> Usage:
    res = _checked(
        run(["zfs", "get", "-Hp", "-o", "value", "used,quota,available", dataset], timeout=30)
    )
    lines = [line.strip() for line in res.stdout.splitlines() if line.strip()]
    used = _parse_int(lines[0]) if len(lines) > 0 else 0
    quota = _parse_int(lines[1]) if len(lines) > 1 else None
    avail = _parse_int(lines[2]) if len(lines) > 2 else None
    return Usage(dataset, used or 0, quota, avail)


def list_usage(root: str) -> list[Usage]:
    """Usage for `root` and all descendants (used for telemetry)."""
    res = run(
        ["zfs", "list", "-Hp", "-r", "-o", "name,used,quota,available", root],
        timeout=60,
    )
    if not res.ok:
        # Root may not exist on this node yet — not an error for telemetry.
        return []
    out: list[Usage] = []
    for line in res.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            parts = line.split()
        if len(parts) < 4:
            continue
        out.append(
            Usage(parts[0], _parse_int(parts[1]) or 0, _parse_int(parts[2]), _parse_int(parts[3]))
        )
    return out


def get_mountpoint(dataset: str) -> str:
    res = _checked(run(["zfs", "get", "-H", "-o", "value", "mountpoint", dataset], timeout=20))
    return res.stdout.strip()


@dataclass
class MountState:
    """Whether a dataset is a REAL, currently-mounted ZFS filesystem at the expected path.

    This is the guard that stops a missing disk from turning into silent writes onto the root
    filesystem: an empty leftover directory at ``/mnt/lab-storage/cold1/labs/labA`` looks exactly
    like a mounted branch to ``os.path.isdir``, so a branch is only ever used when ZFS itself says
    the dataset exists, is mounted, and is mounted where we expect it.
    """

    dataset: str
    exists: bool
    mounted: bool
    mountpoint: str | None
    expected: str | None = None

    @property
    def ok(self) -> bool:
        if not (self.exists and self.mounted and self.mountpoint):
            return False
        if self.expected is None:
            return True
        return self.mountpoint.rstrip("/") == self.expected.rstrip("/")

    def to_dict(self) -> dict:
        return {
            "dataset": self.dataset,
            "exists": self.exists,
            "mounted": self.mounted,
            "mountpoint": self.mountpoint,
            "expected": self.expected,
            "ok": self.ok,
        }


def mount_state(dataset: str, expected: str | None = None) -> MountState:
    res = run(
        ["zfs", "get", "-H", "-o", "value", "mounted,mountpoint", dataset], timeout=20
    )
    if not res.ok:
        return MountState(dataset, False, False, None, expected)
    lines = [line.strip() for line in res.stdout.splitlines() if line.strip()]
    mounted = len(lines) > 0 and lines[0] == "yes"
    mountpoint = lines[1] if len(lines) > 1 else None
    return MountState(dataset, True, mounted, mountpoint, expected)


def mount_dataset(dataset: str) -> None:
    """Mount a dataset, tolerating "already mounted"."""
    res = run(["zfs", "mount", dataset], timeout=60)
    if res.ok or "already mounted" in res.logs.lower():
        return
    raise ZfsError(res.logs)


def pool_exists(pool: str) -> bool:
    return run(["zpool", "list", "-H", "-o", "name", pool], timeout=15).ok


@dataclass
class PoolCapacity:
    name: str
    size: int
    alloc: int
    free: int
    health: str

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "size": self.size,
            "alloc": self.alloc,
            "free": self.free,
            "health": self.health,
        }


def pool_capacity(pool: str) -> PoolCapacity | None:
    """Size/allocated/free/health for one pool, or None when it is not imported."""
    res = run(
        ["zpool", "list", "-Hp", "-o", "name,size,alloc,free,health", pool], timeout=20
    )
    if not res.ok or not res.stdout.strip():
        return None
    parts = res.stdout.split()
    if len(parts) < 5:
        return None
    try:
        return PoolCapacity(parts[0], int(parts[1]), int(parts[2]), int(parts[3]), parts[4])
    except ValueError:
        return None


def list_pool_names() -> list[str]:
    """Every imported pool on this host (used by the WebUI's pool inventory)."""
    res = run(["zpool", "list", "-H", "-o", "name"], timeout=20)
    if not res.ok:
        return []
    return [line.strip() for line in res.stdout.splitlines() if line.strip()]


def pool_guid(pool: str) -> str | None:
    """ZFS's stable numeric pool GUID (survives device-path changes and pool renames)."""
    res = run(["zpool", "get", "-Hp", "-o", "value", "guid", pool], timeout=20)
    value = res.stdout.strip() if res.ok else ""
    return value if value.isdigit() else None


def create_pool(
    pool: str, devices: list[str], *, vdev_type: str = "", force: bool = False
) -> None:
    """Create a NEW zpool. Destructive — the caller must have validated + confirmed.

    ``vdev_type`` is a validated constant ("", "mirror", "raidz1", "raidz2", "raidz3"); it is never
    taken verbatim from the wire (see storage/pools.py).
    """
    args = ["zpool", "create"]
    if force:
        args.append("-f")
    args += ["-o", "ashift=12", "-O", "compression=lz4", "-O", "atime=off",
            "-O", "xattr=sa", "-O", "acltype=posixacl", "-m", "none", pool]
    if vdev_type:
        args.append(vdev_type)
    args += devices
    _checked(run(args, timeout=300))


def destroy_dataset(name: str, *, recursive: bool = True) -> None:
    if not dataset_exists(name):
        return
    args = ["zfs", "destroy"]
    if recursive:
        args.append("-r")
    args.append(name)
    _checked(run(args, timeout=120))


# --------------------------------------------------------------------------- scrub / health


@dataclass
class ScrubStatus:
    pool: str
    state: str  # pool health state, e.g. ONLINE / DEGRADED / UNAVAIL / unknown
    healthy: bool  # state ONLINE and no data errors
    scrubbing: bool  # a scrub is currently in progress
    errors: int  # data-error count (0 = none; -1 = errors present, count unknown)
    last_scrub: str | None  # human text from the `scan:` line
    detail: str  # combined scan/errors text for the controller log

    def to_dict(self) -> dict:
        return {
            "pool": self.pool,
            "state": self.state,
            "healthy": self.healthy,
            "scrubbing": self.scrubbing,
            "errors": self.errors,
            "last_scrub": self.last_scrub,
            "detail": self.detail,
        }


def start_scrub(pool: str) -> bool:
    """Kick off a scrub. Returns True if started (or one was already running)."""
    res = run(["zpool", "scrub", pool], timeout=30)
    if res.ok:
        return True
    # `zpool scrub` errors when a scrub is already in progress — that's not a failure for us.
    if "in progress" in (res.stderr + res.stdout).lower():
        return True
    raise ZfsError(res.logs)


def _parse_errors(line: str) -> int:
    """Parse the `errors:` line of `zpool status` into a count (0, a number, or -1=unknown)."""
    text = line.split("errors:", 1)[-1].strip().lower()
    if text.startswith("no known data errors"):
        return 0
    for tok in text.split():
        if tok.isdigit():
            return int(tok)
    return -1  # errors present but we couldn't parse a count


def parse_scrub_status(pool: str, status_text: str) -> ScrubStatus:
    """Parse `zpool status <pool>` output. Pure function so it is easy to unit-test."""
    state = "unknown"
    errors = 0
    scrubbing = False
    last_scrub: str | None = None
    for raw in status_text.splitlines():
        line = raw.strip()
        if line.startswith("state:"):
            state = line.split("state:", 1)[1].strip()
        elif line.startswith("scan:"):
            last_scrub = line.split("scan:", 1)[1].strip()
            scrubbing = "scrub in progress" in last_scrub.lower()
        elif line.startswith("errors:"):
            errors = _parse_errors(line)
    healthy = state.upper() == "ONLINE" and errors == 0
    detail = f"state={state}; scan={last_scrub or 'n/a'}; errors={errors}"
    return ScrubStatus(pool, state, healthy, scrubbing, errors, last_scrub, detail)


def scrub_status(pool: str) -> ScrubStatus:
    res = run(["zpool", "status", pool], timeout=30)
    if not res.ok:
        return ScrubStatus(pool, "unknown", False, False, -1, None, res.logs)
    return parse_scrub_status(pool, res.stdout)
