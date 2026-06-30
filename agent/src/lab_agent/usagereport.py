"""Publish a per-lab storage-usage snapshot into each lab container, for the `labquota` command.

The agent (root, on the host) writes a small JSON snapshot into a ROOT-OWNED directory OUTSIDE any
student-writable space (under the agent state dir), bind-mounted READ-ONLY into the lab container at
/run/labquota, so an unprivileged student can read their lab's whole usage breakdown without any
network channel and without the agent ever writing into a student-writable mount:

    <state_dir>/labquota/<lab>/usage.json   (0644, root)  -> /run/labquota/usage.json  (ro)
    <state_dir>/labquota/<lab>/status.json  (0644, root)  -> /run/labquota/status.json (ro)

Because the directory is root-only and the bind is read-only, students can read these files but
cannot modify, delete, or replace them with symlinks, and root never follows a student-planted link.
There is **no** shared writable directory: a student requests a fresh usage scan by touching
``.labquota-refresh`` in their *own* scratch dataset (see ``marker_path``), which the agent stats
with lstat and only honors if it is a regular file. Every student-writable surface stays inside that
student's own quota and out of anything the agent parses.

The snapshot has two kinds of numbers:

* **Live tiers** — scratch (fast) and cold-storage (slow) `used`/`quota`. ZFS *metadata*, read for
  every lab/student in a single ``zfs list -r`` per pool (see ``collect_zfs_usage``), so a publish
  is cheap regardless of scale.
* **Container layer** — bytes a student installed into their container home (envs/software). This is
  the one expensive measurement (``du`` per home via ``docker exec``); it is computed on a slow
  cadence / on demand and cached in ``ContainerUsage``, never per publish.

This module is import-safe and its parsing/build helpers are pure so they unit-test without ZFS or
Docker. Only ``collect_*``/``run_container_scan`` and ``*_dir``/publish helpers touch the host.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .config import AgentConfig
from .executors import docker, users, zfs
from .paths import lab_fast
from .protocol import now_ms

USAGE_FILE = "usage.json"
STATUS_FILE = "status.json"
# A student asks for a fresh scan by touching this file in their own /fast/<u> directory. Keeping
# the marker inside the student's own quota-limited
# dataset — instead of a shared world-writable directory — means a flood of markers only ever costs
# the student their own space, and the agent stats exactly one fixed path per known user (never an
# unbounded directory). The marker's contents are never read; only a regular file is honored, and it
# is accessed with lstat/unlink so a symlink or directory planted in its place cannot mislead root.
REFRESH_MARKER = ".labquota-refresh"


# --------------------------------------------------------------------------- container-layer cache


@dataclass
class ContainerUsage:
    """Cached per-student usage from the expensive ``du`` scan (updated only by a scan).

    Holds the container writable layer total plus, for each student, the three numbers the cheap
    publish loop cannot get from ZFS metadata: their container home (installed software), and —
    since there are no per-student ZFS datasets — their scratch and cold directory sizes
    measured with ``du``.
    """

    scanned_at: int | None = None  # epoch ms of the last successful scan
    status: str = "idle"  # "idle" | "running"
    total_used: int | None = None  # container writable layer (SizeRw)
    per_user: dict[str, int] = field(default_factory=dict)  # username -> home du bytes
    per_user_fast: dict[str, int] = field(default_factory=dict)  # username -> scratch du bytes
    per_user_slow: dict[str, int] = field(default_factory=dict)  # username -> cold-storage du bytes
    unattributed: int | None = None  # total - sum(per_user), files outside any home (/tmp, etc.)

    def to_dict(self) -> dict[str, Any]:
        return {
            "scanned_at": self.scanned_at,
            "status": self.status,
            "total_used": self.total_used,
            "per_user": dict(self.per_user),
            "per_user_fast": dict(self.per_user_fast),
            "per_user_slow": dict(self.per_user_slow),
            "unattributed": self.unattributed,
        }


@dataclass
class LabLevelUsage:
    """Cached lab-level storage totals, refreshed on a fixed cadence (NOT per heartbeat).

    Holds the ready-to-emit telemetry rows for one lab's lab-level usage: the fast/slow ZFS
    used/quota rows plus the container writable-layer ("image") total. The agent recomputes these on
    its lab-usage cadence (``lab_usage_interval_s``) — or immediately on an on-demand scan — and
    caches them here; the heartbeat just re-reports the cached ``storage`` every cycle, so the
    expensive ``zfs list`` / ``docker inspect`` work no longer runs on every 15s heartbeat.
    """

    computed_at: int | None = None  # epoch ms of the last refresh
    storage: list[dict[str, Any]] = field(default_factory=list)  # lab-level telemetry rows


class UsageState:
    """Per-lab usage cache shared between the publish loop, the scan loop, and telemetry.

    Two independently-cadenced caches: ``_container`` is the expensive per-student ``du`` breakdown
    (refreshed by the nightly / on-demand scan) and ``_lab`` is the lab-level totals (fast/slow ZFS
    + container writable layer, refreshed every ``lab_usage_interval_s`` / on demand).
    """

    def __init__(self) -> None:
        self._container: dict[str, ContainerUsage] = {}
        self._lab: dict[str, LabLevelUsage] = {}

    def container_for(self, lab: str) -> ContainerUsage:
        return self._container.get(lab, ContainerUsage())

    def set_container(self, lab: str, usage: ContainerUsage) -> None:
        self._container[lab] = usage

    def all_container(self) -> dict[str, ContainerUsage]:
        return dict(self._container)

    def lab_level_for(self, lab: str) -> LabLevelUsage:
        return self._lab.get(lab, LabLevelUsage())

    def set_lab_level(self, lab: str, usage: LabLevelUsage) -> None:
        self._lab[lab] = usage

    def all_lab_level(self) -> dict[str, LabLevelUsage]:
        return dict(self._lab)

    def replace_lab_level(self, mapping: dict[str, LabLevelUsage]) -> None:
        """Swap in a freshly-computed map for every lab, so labs that disappeared drop out."""
        self._lab = dict(mapping)


# --------------------------------------------------------------------------- ZFS usage collection


@dataclass
class LabUsage:
    """Live ZFS usage for one lab. Per-student values come from directory scans."""

    fast: zfs.Usage | None = None
    slow: zfs.Usage | None = None
    users: dict[str, dict[str, zfs.Usage]] = field(default_factory=dict)  # user -> {fast,slow}


def _parse_dataset(dataset: str, root: str) -> tuple[str, str | None] | None:
    """Map exactly ``<root>/<lab>`` to a lab-level row; descendants are ignored."""
    prefix = root.rstrip("/") + "/"
    if not dataset.startswith(prefix):
        return None
    rest = dataset[len(prefix):].split("/")
    lab = rest[0]
    if not lab:
        return None
    if len(rest) == 1:
        return lab, None
    return None


def _ingest_rows(out: dict[str, LabUsage], rows: list[zfs.Usage], root: str, tier: str) -> None:
    for u in rows:
        parsed = _parse_dataset(u.dataset, root)
        if parsed is None:
            continue
        lab, _user = parsed
        entry = out.setdefault(lab, LabUsage())
        setattr(entry, tier, u)


def collect_zfs_usage(cfg: AgentConfig) -> dict[str, LabUsage]:
    """All labs' live ZFS usage from one ``zfs list -r`` per pool (cheap; no per-dataset calls)."""
    out: dict[str, LabUsage] = {}
    _ingest_rows(out, zfs.list_usage(cfg.labs_fast_root), cfg.labs_fast_root, "fast")
    if cfg.slow_is_zfs:
        _ingest_rows(out, zfs.list_usage(cfg.labs_slow_root), cfg.labs_slow_root, "slow")
    return out


def list_lab_students(cfg: AgentConfig, lab: str) -> list[str]:
    """Enumerate provisioned students from direct children of the lab's fast mount."""
    try:
        entries = os.listdir(_fast_lab_mp(cfg, lab))
    except OSError:
        return []
    return sorted(e for e in entries if users.USERNAME_RE.match(e))


# --------------------------------------------------------------------------- snapshot building


def _usage_pair(u: zfs.Usage | None) -> dict[str, int | None] | None:
    if u is None:
        return None
    return {"used": u.used_bytes, "quota": u.quota_bytes}


def build_snapshot(
    cfg: AgentConfig,
    lab: str,
    lab_usage: LabUsage,
    container_usage: ContainerUsage,
    *,
    roster: list[str] | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    """Assemble one lab snapshot from live ZFS metadata and cached container usage."""
    now = now if now is not None else now_ms()
    # With no per-student ZFS datasets, scratch/cold no longer have cheap per-student metadata (the
    # lab quota covers everyone), so a student may appear only in the container-layer measurement,
    # or before any scan has run, in neither. Union the explicit ``roster`` (provisioned scratch
    # subdirs) with both usage sources so every provisioned student is listed even without numbers.
    names = set(lab_usage.users.keys()) | set(container_usage.per_user.keys())
    if roster:
        names |= set(roster)
    usernames = sorted(names)
    students = []
    for name in usernames:
        tiers = lab_usage.users.get(name, {})
        # Use a scan's ``du`` measurement (used-only; the lab quota covers every student).
        scratch = _usage_pair(tiers.get("fast"))
        if scratch is None and name in container_usage.per_user_fast:
            scratch = {"used": container_usage.per_user_fast[name], "quota": None}
        cold = _usage_pair(tiers.get("slow"))
        if cold is None and name in container_usage.per_user_slow:
            cold = {"used": container_usage.per_user_slow[name], "quota": None}
        students.append(
            {
                "username": name,
                "scratch": scratch,
                "cold": cold,
                "home_used": container_usage.per_user.get(name),
            }
        )
    return {
        "generated_at": now,
        "node": cfg.node_name,
        "lab": lab,
        "totals": {
            "fast": _usage_pair(lab_usage.fast),
            "cold": _usage_pair(lab_usage.slow),
            "rootfs_used": container_usage.total_used,
        },
        "usage_scanned_at": container_usage.scanned_at,
        "usage_scan": container_usage.status,
        "rootfs_unattributed": container_usage.unattributed,
        "students": students,
    }


def live_container_storage(lab: str) -> dict[str, Any] | None:
    """The lab-level outer-container writable-layer (``SizeRw``) telemetry row.

    This is the rootfs number, measured with one ``docker inspect --size``.
    It is recomputed on the agent's lab-usage cadence (``lab_usage_interval_s``) and cached in
    ``LabLevelUsage`` — not measured on every heartbeat — alongside the lab-level ZFS rows (see
    ``lab_level_for``). Returns None when the container is absent or the measurement fails, in which
    case the row is omitted and the controller keeps the last known value.
    """
    container = docker.container_name(lab)
    if not docker.container_exists(container):
        return None
    total = docker.writable_layer_size(container)
    if total is None:
        return None
    return {
        "lab": lab,
        "user": None,
        "tier": "rootfs",
        "used_bytes": total,
        "quota_bytes": None,
        "available_bytes": None,
    }


def _zfs_row(lab: str, tier: str, u: zfs.Usage) -> dict[str, Any]:
    return {
        "lab": lab,
        "user": None,
        "tier": tier,
        "used_bytes": u.used_bytes,
        "quota_bytes": u.quota_bytes,
        "available_bytes": u.available_bytes,
    }


def lab_level_for(
    cfg: AgentConfig, lab: str, lab_usage: LabUsage | None = None, *, now: int | None = None
) -> LabLevelUsage:
    """Compute one lab's lab-level usage rows: fast/slow ZFS (+ any per-student ZFS datasets) plus
    the container writable-layer "image" total. ``lab_usage`` may be passed in (e.g. from a single
    ``collect_zfs_usage`` covering all labs) to avoid re-listing ZFS per lab."""
    now = now if now is not None else now_ms()
    if lab_usage is None:
        lab_usage = collect_zfs_usage(cfg).get(lab, LabUsage())
    rows: list[dict[str, Any]] = []
    if lab_usage.fast is not None:
        rows.append(_zfs_row(lab, "fast", lab_usage.fast))
    if lab_usage.slow is not None:
        rows.append(_zfs_row(lab, "cold", lab_usage.slow))
    image = live_container_storage(lab)
    if image is not None:
        rows.append(image)
    return LabLevelUsage(computed_at=now, storage=rows)


def collect_lab_level(
    cfg: AgentConfig, usage_state: UsageState | None = None, *, now: int | None = None
) -> dict[str, LabLevelUsage]:
    """Recompute lab-level usage for every lab: one ``zfs list`` per pool + one ``docker inspect
    --size`` per lab. This is the work that used to run on every 15s heartbeat; it now runs on the
    agent's lab-usage cadence and is cached. Labs are enumerated from ZFS (every lab has a fast
    dataset), unioned with any lab present only in the container-scan cache."""
    now = now if now is not None else now_ms()
    grouped = collect_zfs_usage(cfg)
    labs = set(grouped.keys())
    if usage_state is not None:
        labs |= set(usage_state.all_container().keys())
    return {
        lab: lab_level_for(cfg, lab, grouped.get(lab, LabUsage()), now=now) for lab in sorted(labs)
    }


def rootfs_storage(lab: str, container_usage: ContainerUsage) -> list[dict[str, Any]]:
    """Per-student container-home telemetry rows from the cached usage scan.

    The lab-level container total is **not** emitted here — it lives in the lab-level cache
    (``lab_level_for`` / ``live_container_dataset``), refreshed on the lab-usage cadence. These
    per-student rows come from the ``du`` scan cache and only change when a scan runs. Quota is
    omitted because the writable layer is not a per-student quota and must not alert.
    """
    rows: list[dict[str, Any]] = []
    for user, used in container_usage.per_user.items():
        rows.append(
            {
                "lab": lab,
                "user": user,
                "tier": "rootfs",
                "used_bytes": used,
                "quota_bytes": None,
                "available_bytes": None,
            }
        )
    return rows


def tier_storage(lab: str, container_usage: ContainerUsage) -> list[dict[str, Any]]:
    """Telemetry rows for the per-student scratch (fast) / cold (slow) ``du`` breakdown.

    With no per-student ZFS datasets, the scan measures each student's directory with ``du``. Quota
    is omitted because the per-student number is a breakdown, not a quota, so it must never raise a
    PI quota alert.
    """
    rows: list[dict[str, Any]] = []
    tiers = (("fast", container_usage.per_user_fast), ("cold", container_usage.per_user_slow))
    for tier, per_user in tiers:
        for user, used in per_user.items():
            rows.append(
                {
                    "lab": lab,
                    "user": user,
                    "tier": tier,
                    "used_bytes": used,
                    "quota_bytes": None,
                    "available_bytes": None,
                }
            )
    return rows


# --------------------------------------------------------------------------- on-host I/O


def _fast_lab_mp(cfg: AgentConfig, lab: str) -> str:
    return zfs.get_mountpoint(lab_fast(cfg, lab))


# Container path the labquota status dir is bind-mounted read-only at (see docker.build_run_args).
CONTAINER_LABQUOTA_DIR = "/run/labquota"


def labquota_dir(cfg: AgentConfig, lab: str) -> str:
    """Host path of the lab's labquota status directory. This is a ROOT-OWNED directory OUTSIDE any
    student-writable space (under the agent state dir, /var/lib/lab-agent/labquota/<lab>), bind-
    mounted read-only into the container at /run/labquota. The agent never writes into the student-
    writable ZFS mount, so a student can't plant a symlink to redirect a root write."""
    return os.path.join(os.path.dirname(cfg.state_db) or "/var/lib/lab-agent", "labquota", lab)


def marker_path(cfg: AgentConfig, lab: str, user: str) -> str:
    """A student's refresh marker, in their own scratch dataset (their quota, not a shared dir)."""
    return os.path.join(_fast_lab_mp(cfg, lab), user, REFRESH_MARKER)


def ensure_labquota_dirs(cfg: AgentConfig, lab: str) -> str:
    """Create the root-owned status directory (0755 so the container can read it). Returns the base
    path. Nothing the agent reads is student-writable: students signal a refresh from their own
    dataset (see ``marker_path``), and the status dir is bind-mounted read-only."""
    base = labquota_dir(cfg, lab)
    os.makedirs(base, exist_ok=True)
    os.chmod(base, 0o755)
    return base


def _atomic_write_json(path: str, payload: dict[str, Any]) -> None:
    """Write JSON atomically and WITHOUT following symlinks (O_NOFOLLOW), leaving the previous file
    intact on failure. The dir is root-only, but O_NOFOLLOW is defence-in-depth so a symlink at
    the tmp/target path can never redirect the write."""
    tmp = f"{path}.tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except OSError:
        # A failed write (symlink planted, disk full) keeps the last good file; drop the tmp.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def publish_snapshot(cfg: AgentConfig, lab: str, snapshot: dict[str, Any]) -> None:
    _atomic_write_json(os.path.join(labquota_dir(cfg, lab), USAGE_FILE), snapshot)


def write_status(cfg: AgentConfig, lab: str, status: dict[str, Any]) -> None:
    _atomic_write_json(os.path.join(labquota_dir(cfg, lab), STATUS_FILE), status)


def newest_request(cfg: AgentConfig, lab: str, users: list[str]) -> int | None:
    """Newest refresh-marker mtime (epoch ms) across the given users, or None if none pending.

    Only a regular file is honored, accessed with ``lstat`` so a symlink or directory a student
    plants in place of the marker is ignored (and can never make root follow a link). Contents are
    never read.
    """
    import stat as _stat

    newest: int | None = None
    for user in users:
        try:
            st = os.lstat(marker_path(cfg, lab, user))
        except OSError:
            continue
        if not _stat.S_ISREG(st.st_mode):
            continue
        mtime = int(st.st_mtime * 1000)
        if newest is None or mtime > newest:
            newest = mtime
    return newest


def clear_requests(cfg: AgentConfig, lab: str, users: list[str]) -> None:
    """Remove each user's refresh marker after a scan. ``unlink`` removes only the file/symlink
    itself, never any target it might point at."""
    for user in users:
        try:
            os.unlink(marker_path(cfg, lab, user))
        except OSError:
            continue


# --------------------------------------------------------------------------- container-layer scan

ProgressCb = Callable[[int, int, str], None]


def run_container_scan(
    cfg: AgentConfig,
    lab: str,
    usernames: list[str],
    *,
    progress: ProgressCb | None = None,
    now: int | None = None,
) -> ContainerUsage:
    """Measure the container writable layer + per-student usage. The expensive path (`du` per dir).

    For each student we ``du`` three directories inside the container: their container home
    (installed software), their scratch (``/fast/<u>``) and — only when this node owns cold storage
    (local ZFS; on the SMB client the owner node reports it) — their cold-storage
    (``/cold/<u>``). Returns an idle ContainerUsage with whatever was measured. Missing
    container / failed ``du`` degrade to None/omitted entries rather than raising, so one bad lab
    never breaks the loop.
    """
    now = now if now is not None else now_ms()
    container = docker.container_name(lab)
    if not docker.container_exists(container):
        return ContainerUsage(scanned_at=now, status="idle")
    total = docker.writable_layer_size(container)
    per_user: dict[str, int] = {}
    per_user_fast: dict[str, int] = {}
    per_user_slow: dict[str, int] = {}
    valid = [u for u in usernames if users.USERNAME_RE.match(u)]
    measure_cold = cfg.slow_is_zfs
    for i, user in enumerate(valid):
        if progress is not None:
            progress(i, len(valid), user)
        home = docker.du_home(container, user)
        if home is not None:
            per_user[user] = home
        fast = docker.du_path(container, f"/fast/{user}")
        if fast is not None:
            per_user_fast[user] = fast
        if measure_cold:
            cold = docker.du_path(container, f"/cold/{user}")
            if cold is not None:
                per_user_slow[user] = cold
    unattributed = None
    if total is not None:
        unattributed = max(0, total - sum(per_user.values()))
    return ContainerUsage(
        scanned_at=now,
        status="idle",
        total_used=total,
        per_user=per_user,
        per_user_fast=per_user_fast,
        per_user_slow=per_user_slow,
        unattributed=unattributed,
    )
