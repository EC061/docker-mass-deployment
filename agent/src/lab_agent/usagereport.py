"""Publish a per-lab storage-usage snapshot into each lab container, for the `labquota` command.

The agent (root, on the host) writes a small JSON snapshot into a directory bind-mounted into the
lab container, so an unprivileged student can read their lab's whole usage breakdown without any
network channel:

    <fast_users_mp>/.labquota/usage.json   (0644, root)  -> /labusers/fast/.labquota/usage.json
    <fast_users_mp>/.labquota/status.json  (0644, root)  -> live scan progress

Both files live in a root-owned directory inside a root-owned dataset, so students can read them but
cannot modify, delete, or replace them with symlinks. There is **no** shared writable directory: a
student requests a fresh docker scan by touching ``.labquota-refresh`` in their *own* scratch
dataset (see ``marker_path``), which the agent stats with lstat and only honors if it is a regular
file. This keeps every student-writable surface inside that student's own quota and out of anything
the agent parses.

The snapshot has two kinds of numbers:

* **Live tiers** — scratch (fast) and cold-storage (slow) `used`/`quota`. ZFS *metadata*, read for
  every lab/student in a single ``zfs list -r`` per pool (see ``collect_zfs_usage``), so a publish
  is cheap regardless of scale.
* **Docker layer** — bytes a student installed into their container home (envs/software). This is
  the one expensive measurement (``du`` per home via ``docker exec``); it is computed on a slow
  cadence / on demand and cached in ``DockerUsage``, never per publish.

This module is import-safe and its parsing/build helpers are pure so they unit-test without ZFS or
Docker. Only the ``collect_*``/``run_docker_scan`` and the ``*_dir``/publish helpers touch the host.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .config import AgentConfig
from .executors import docker, users, zfs
from .paths import lab_fast_users
from .protocol import now_ms

LABQUOTA_DIRNAME = ".labquota"
USAGE_FILE = "usage.json"
STATUS_FILE = "status.json"
# A student asks for a fresh docker scan by touching this file in their OWN scratch dataset
# (/labusers/fast/<u>/.labquota-refresh). Keeping the marker inside the student's own quota-limited
# dataset — instead of a shared world-writable directory — means a flood of markers only ever costs
# the student their own space, and the agent stats exactly one fixed path per known user (never an
# unbounded directory). The marker's contents are never read; only a regular file is honored, and it
# is accessed with lstat/unlink so a symlink or directory planted in its place cannot mislead root.
REFRESH_MARKER = ".labquota-refresh"


# --------------------------------------------------------------------------- docker-layer cache


@dataclass
class DockerUsage:
    """Cached per-student usage from the expensive ``du`` scan (updated only by a scan).

    Holds the container writable layer total plus, for each student, the three numbers the cheap
    publish loop cannot get from ZFS metadata: their docker home (installed software), and — since
    there are no per-student ZFS datasets — their scratch (fast) and cold (slow) directory sizes
    measured with ``du``.
    """

    scanned_at: int | None = None  # epoch ms of the last successful scan
    status: str = "idle"  # "idle" | "running"
    total_used: int | None = None  # container writable layer (SizeRw)
    per_user: dict[str, int] = field(default_factory=dict)  # username -> docker-home du bytes
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
    caches them here; the heartbeat just re-reports the cached ``datasets`` every cycle, so the
    expensive ``zfs list`` / ``docker inspect`` work no longer runs on every 15s heartbeat.
    """

    computed_at: int | None = None  # epoch ms of the last refresh
    datasets: list[dict[str, Any]] = field(default_factory=list)  # lab-level telemetry rows


class UsageState:
    """Per-lab usage cache shared between the publish loop, the scan loop, and telemetry.

    Two independently-cadenced caches: ``_docker`` is the expensive per-student ``du`` breakdown
    (refreshed by the nightly / on-demand scan) and ``_lab`` is the lab-level totals (fast/slow ZFS
    + container writable layer, refreshed every ``lab_usage_interval_s`` / on demand).
    """

    def __init__(self) -> None:
        self._docker: dict[str, DockerUsage] = {}
        self._lab: dict[str, LabLevelUsage] = {}

    def docker_for(self, lab: str) -> DockerUsage:
        return self._docker.get(lab, DockerUsage())

    def set_docker(self, lab: str, usage: DockerUsage) -> None:
        self._docker[lab] = usage

    def all_docker(self) -> dict[str, DockerUsage]:
        return dict(self._docker)

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
    """Live ZFS usage for one lab: lab-level totals + per-student fast/slow datasets."""

    fast: zfs.Usage | None = None
    slow: zfs.Usage | None = None
    users: dict[str, dict[str, zfs.Usage]] = field(default_factory=dict)  # user -> {fast,slow}


def _parse_dataset(dataset: str, root: str) -> tuple[str, str | None] | None:
    """Map a dataset under ``root`` to (lab, user|None). Returns None for shared/users/other rows.

    root is e.g. ``fast/labs``; ``fast/labs/<lab>`` is lab-level (user None),
    ``fast/labs/<lab>/users/<u>`` is a student. Anything else (shared, the users parent) is skipped.
    """
    prefix = root.rstrip("/") + "/"
    if not dataset.startswith(prefix):
        return None
    rest = dataset[len(prefix):].split("/")
    lab = rest[0]
    if not lab:
        return None
    if len(rest) == 1:
        return lab, None
    if len(rest) == 3 and rest[1] == "users":
        return lab, rest[2]
    return None


def _ingest_rows(out: dict[str, LabUsage], rows: list[zfs.Usage], root: str, tier: str) -> None:
    for u in rows:
        parsed = _parse_dataset(u.dataset, root)
        if parsed is None:
            continue
        lab, user = parsed
        entry = out.setdefault(lab, LabUsage())
        if user is None:
            setattr(entry, tier, u)
        else:
            entry.users.setdefault(user, {})[tier] = u


def collect_zfs_usage(cfg: AgentConfig) -> dict[str, LabUsage]:
    """All labs' live ZFS usage from one ``zfs list -r`` per pool (cheap; no per-dataset calls)."""
    out: dict[str, LabUsage] = {}
    _ingest_rows(out, zfs.list_usage(cfg.labs_fast_root), cfg.labs_fast_root, "fast")
    if cfg.slow_is_zfs:
        _ingest_rows(out, zfs.list_usage(cfg.labs_slow_root), cfg.labs_slow_root, "slow")
    return out


def list_lab_students(cfg: AgentConfig, lab: str) -> list[str]:
    """Enumerate a lab's provisioned students by listing its fast ``users`` mountpoint subdirs.

    With no per-student ZFS datasets, the only durable host-side record of who is provisioned is the
    set of per-student scratch subdirs that ``users.add_user`` creates (``/labusers/fast/<u>``). We
    list that directory and keep only entries that are valid usernames — this skips the root-owned
    ``.labquota`` dir and any stray files — so the roster reflects exactly the students added to the
    lab, independent of whether per-student ZFS datasets exist. This is the roster source the
    snapshot and docker scan need (``lab_usage.users`` is empty without per-student datasets).
    """
    try:
        entries = os.listdir(_fast_users_mp(cfg, lab))
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
    docker_usage: DockerUsage,
    *,
    roster: list[str] | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    """Pure builder: assemble the JSON snapshot for one lab from live ZFS + cached docker usage."""
    now = now if now is not None else now_ms()
    # With no per-student ZFS datasets, scratch/cold no longer have cheap per-student metadata (the
    # lab quota covers everyone), so a student may appear only in the docker-layer measurement — or,
    # before any docker scan has run, in neither. Union the explicit ``roster`` (provisioned scratch
    # subdirs) with both usage sources so every provisioned student is listed even without numbers.
    names = set(lab_usage.users.keys()) | set(docker_usage.per_user.keys())
    if roster:
        names |= set(roster)
    usernames = sorted(names)
    students = []
    for name in usernames:
        tiers = lab_usage.users.get(name, {})
        # Prefer ZFS metadata when per-student datasets exist; otherwise fall back to the docker
        # scan's ``du`` measurement (used-only, no per-student quota — the lab quota covers all).
        scratch = _usage_pair(tiers.get("fast"))
        if scratch is None and name in docker_usage.per_user_fast:
            scratch = {"used": docker_usage.per_user_fast[name], "quota": None}
        cold = _usage_pair(tiers.get("slow"))
        if cold is None and name in docker_usage.per_user_slow:
            cold = {"used": docker_usage.per_user_slow[name], "quota": None}
        students.append(
            {
                "username": name,
                "scratch": scratch,
                "cold": cold,
                "docker_home_used": docker_usage.per_user.get(name),
            }
        )
    return {
        "generated_at": now,
        "node": cfg.node_name,
        "lab": lab,
        "totals": {
            "fast": _usage_pair(lab_usage.fast),
            "slow": _usage_pair(lab_usage.slow),
            "docker_used": docker_usage.total_used,
        },
        "docker_scanned_at": docker_usage.scanned_at,
        "docker_scan": docker_usage.status,
        "docker_unattributed": docker_usage.unattributed,
        "students": students,
    }


def live_docker_dataset(lab: str) -> dict[str, Any] | None:
    """The lab-level docker writable-layer (``SizeRw``) telemetry row.

    This is the "whole image" / container-level number, measured with one ``docker inspect --size``.
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
        "pool": "docker",
        "dataset": f"docker/labs/{lab}",
        "used_bytes": total,
        "quota_bytes": None,
    }


def _zfs_row(pool: str, u: zfs.Usage) -> dict[str, Any]:
    return {
        "pool": pool,
        "dataset": u.dataset,
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
        rows.append(_zfs_row("fast", lab_usage.fast))
    if lab_usage.slow is not None:
        rows.append(_zfs_row("slow", lab_usage.slow))
    # Per-student ZFS rows only exist if per-student datasets are in use; normally empty (scratch
    # and cold come from the du scan's tier_datasets instead). Included so both layouts work.
    for tiers in lab_usage.users.values():
        if "fast" in tiers:
            rows.append(_zfs_row("fast", tiers["fast"]))
        if "slow" in tiers:
            rows.append(_zfs_row("slow", tiers["slow"]))
    image = live_docker_dataset(lab)
    if image is not None:
        rows.append(image)
    return LabLevelUsage(computed_at=now, datasets=rows)


def collect_lab_level(
    cfg: AgentConfig, docker_state: UsageState | None = None, *, now: int | None = None
) -> dict[str, LabLevelUsage]:
    """Recompute lab-level usage for every lab: one ``zfs list`` per pool + one ``docker inspect
    --size`` per lab. This is the work that used to run on every 15s heartbeat; it now runs on the
    agent's lab-usage cadence and is cached. Labs are enumerated from ZFS (every lab has a fast
    dataset), unioned with any lab present only in the docker-scan cache."""
    now = now if now is not None else now_ms()
    grouped = collect_zfs_usage(cfg)
    labs = set(grouped.keys())
    if docker_state is not None:
        labs |= set(docker_state.all_docker().keys())
    return {
        lab: lab_level_for(cfg, lab, grouped.get(lab, LabUsage()), now=now) for lab in sorted(labs)
    }


def docker_datasets(lab: str, docker_usage: DockerUsage) -> list[dict[str, Any]]:
    """Per-student docker-home telemetry rows from the cached scan (installed software per student).

    The lab-level container total is **not** emitted here — it lives in the lab-level cache
    (``lab_level_for`` / ``live_docker_dataset``), refreshed on the lab-usage cadence. These
    per-student rows come from the (expensive) ``du`` scan cache and only change when a scan runs.
    Dataset names mirror the ZFS layout
    (``docker/labs/<lab>/users/<u>``) so the controller's ``parseDataset`` maps them to the right
    student. quota is omitted (the writable layer is not a per-student quota and must not alert).
    """
    rows: list[dict[str, Any]] = []
    for user, used in docker_usage.per_user.items():
        rows.append(
            {
                "pool": "docker",
                "dataset": f"docker/labs/{lab}/users/{user}",
                "used_bytes": used,
                "quota_bytes": None,
            }
        )
    return rows


def tier_datasets(lab: str, docker_usage: DockerUsage) -> list[dict[str, Any]]:
    """Telemetry rows for the per-student scratch (fast) / cold (slow) ``du`` breakdown.

    With no per-student ZFS datasets, scratch/cold have no cheap per-student metadata, so the scan
    measures each student's directory with ``du`` instead (the lab-level fast/slow rows still come
    from ZFS metadata in the heartbeat). Dataset names mirror the ZFS layout
    (``<pool>/labs/<lab>/users/<u>``) so the controller's ``parseDataset`` maps them to the right
    lab/student. quota is omitted — the per-student number is a breakdown, not a quota (the lab
    quota covers everyone), so it must never raise a PI quota alert.
    """
    rows: list[dict[str, Any]] = []
    tiers = (("fast", docker_usage.per_user_fast), ("slow", docker_usage.per_user_slow))
    for pool, per_user in tiers:
        for user, used in per_user.items():
            rows.append(
                {
                    "pool": pool,
                    "dataset": f"{pool}/labs/{lab}/users/{user}",
                    "used_bytes": used,
                    "quota_bytes": None,
                }
            )
    return rows


# --------------------------------------------------------------------------- on-host I/O


def _fast_users_mp(cfg: AgentConfig, lab: str) -> str:
    """Host mountpoint of the lab's fast `users` dataset (bind-mounted to /labusers/fast)."""
    return zfs.get_mountpoint(lab_fast_users(cfg, lab))


def labquota_dir(cfg: AgentConfig, lab: str) -> str:
    """Host path of the lab's .labquota directory (root-owned; students can read, not write)."""
    return os.path.join(_fast_users_mp(cfg, lab), LABQUOTA_DIRNAME)


def marker_path(cfg: AgentConfig, lab: str, user: str) -> str:
    """A student's refresh marker, in their own scratch dataset (their quota, not a shared dir)."""
    return os.path.join(_fast_users_mp(cfg, lab), user, REFRESH_MARKER)


def ensure_labquota_dirs(cfg: AgentConfig, lab: str) -> str:
    """Create the root-owned .labquota/ directory (0755). Returns the base path.

    There is intentionally no world-writable directory here: students signal a refresh from their
    own dataset (see ``marker_path``), so nothing the agent reads is student-writable.
    """
    base = labquota_dir(cfg, lab)
    os.makedirs(base, exist_ok=True)
    os.chmod(base, 0o755)
    return base


def _atomic_write_json(path: str, payload: dict[str, Any]) -> None:
    """Write JSON atomically; on failure (e.g. lab quota full) leave the previous file intact."""
    tmp = f"{path}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except OSError:
        # A student filling the lab quota can fail the write; keep the last good file, drop the tmp.
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


# --------------------------------------------------------------------------- docker-layer scan

ProgressCb = Callable[[int, int, str], None]


def run_docker_scan(
    cfg: AgentConfig,
    lab: str,
    usernames: list[str],
    *,
    progress: ProgressCb | None = None,
    now: int | None = None,
) -> DockerUsage:
    """Measure the container writable layer + per-student usage. The expensive path (`du` per dir).

    For each student we ``du`` three directories inside the container: their docker home (installed
    software), their scratch (``/labusers/fast/<u>``) and — only when this node owns cold storage
    (local ZFS; on the SMB client the owner node reports it) — their cold-storage
    (``/labusers/slow/<u>``). Returns an idle DockerUsage with whatever was measured. Missing
    container / failed ``du`` degrade to None/omitted entries rather than raising, so one bad lab
    never breaks the loop.
    """
    now = now if now is not None else now_ms()
    container = docker.container_name(lab)
    if not docker.container_exists(container):
        return DockerUsage(scanned_at=now, status="idle")
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
        fast = docker.du_path(container, f"/labusers/fast/{user}")
        if fast is not None:
            per_user_fast[user] = fast
        if measure_cold:
            cold = docker.du_path(container, f"/labusers/slow/{user}")
            if cold is not None:
                per_user_slow[user] = cold
    unattributed = None
    if total is not None:
        unattributed = max(0, total - sum(per_user.values()))
    return DockerUsage(
        scanned_at=now,
        status="idle",
        total_used=total,
        per_user=per_user,
        per_user_fast=per_user_fast,
        per_user_slow=per_user_slow,
        unattributed=unattributed,
    )
