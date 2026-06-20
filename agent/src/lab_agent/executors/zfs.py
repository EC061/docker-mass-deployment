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
    name: str, *, quota_bytes: int | None = None, create_parents: bool = True
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
