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


class UsageState:
    """Per-lab docker-usage cache shared between the publish loop, the scan loop, and telemetry."""

    def __init__(self) -> None:
        self._docker: dict[str, DockerUsage] = {}

    def docker_for(self, lab: str) -> DockerUsage:
        return self._docker.get(lab, DockerUsage())

    def set_docker(self, lab: str, usage: DockerUsage) -> None:
        self._docker[lab] = usage

    def all_docker(self) -> dict[str, DockerUsage]:
        return dict(self._docker)


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


def docker_datasets(lab: str, docker_usage: DockerUsage) -> list[dict[str, Any]]:
    """Telemetry rows for the docker layer (pool="docker"), reusing the controller's ingest path.

    Dataset names mirror the ZFS layout (``docker/labs/<lab>[/users/<u>]``) so the controller's
    existing ``parseDataset`` maps them to the right lab/student. quota is omitted (the writable
    layer's fixed per-container limit is not a per-student quota and should not raise PI alerts).
    """
    rows: list[dict[str, Any]] = []
    if docker_usage.total_used is not None:
        rows.append(
            {
                "pool": "docker",
                "dataset": f"docker/labs/{lab}",
                "used_bytes": docker_usage.total_used,
                "quota_bytes": None,
            }
        )
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
