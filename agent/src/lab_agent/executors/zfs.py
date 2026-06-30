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
) -> None:
    """Create a dataset (idempotent). Optionally set a quota."""
    if not dataset_exists(name):
        args = ["zfs", "create"]
        if create_parents:
            args.append("-p")
        args.append(name)
        _checked(run(args, timeout=60))
    if quota_bytes is not None:
        set_quota(name, quota_bytes)
    if mountpoint is not None:
        set_property(name, "mountpoint", mountpoint)


def set_property(dataset: str, key: str, value: str) -> None:
    """Set one trusted ZFS property. Keys are internal constants, never user input."""
    _checked(run(["zfs", "set", f"{key}={value}", dataset], timeout=30))


def set_quota(dataset: str, quota_bytes: int | None) -> None:
    """Set (or clear, when None) the quota on a dataset. Applies live."""
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
