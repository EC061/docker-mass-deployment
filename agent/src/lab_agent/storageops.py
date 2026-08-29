"""Dispatcher handlers for controller-driven storage management.

These are the operations the controller's storage UI calls. Each is a thin, validating wrapper
around ``storage.service`` — the controller never assembles a shell command, and every value that
crosses the wire (tier name, pool name, device path, mergerfs option, vdev type) is re-validated
here against an allow-list before it can reach an argv. The agent runs as root; the wire is treated
as untrusted input even though it is authenticated.

Destructive operations (``storage.create_pool``) additionally require an explicit ``confirm`` flag,
so a mis-routed or replayed task can never wipe a disk on its own.

Storage topology changes are written back into the local config file, because the node must be able
to mount its own storage with the controller offline (see the bootstrap/controller-authoritative
split in ``config``).
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from .config import DEFAULT_CONFIG_PATH, AgentConfig, save_config
from .executors import zfs
from .storage import pools as poolinv
from .storage import service
from .storage.model import StorageConfigError, validate_pool_name
from .storage.state import StorageState


def _persist(cfg: AgentConfig) -> str:
    """Write the (possibly changed) storage topology back to the local config file."""
    path = Path(os.environ.get("LAB_AGENT_CONFIG", str(DEFAULT_CONFIG_PATH)))
    if not path.exists():
        return f"config {path} not present; topology change kept in memory only"
    save_config(cfg, path)
    return f"storage topology written to {path}"


def _tier(params: dict[str, Any]) -> str:
    return service.validate_tier_name(params.get("tier"))


# --------------------------------------------------------------------------- read-only


def list_devices(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Physical disks with stable by-id identity, so the UI can offer a safe 'add drive' picker."""
    devices = [d.to_dict() for d in poolinv.list_block_devices()]
    return {"devices": devices}, f"{len(devices)} block device(s)"


def list_pools(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    known = cfg.storage.owned_pools
    seen = list(known)
    for pool in zfs.list_pool_names():
        if pool not in seen:
            seen.append(pool)
    infos = [
        poolinv.inspect_pool(pool, tiers=cfg.storage.tiers_for_pool(pool)).to_dict()
        for pool in seen
    ]
    return {"pools": infos}, f"{len(infos)} ZFS pool(s)"


def status(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """The full storage inventory: config, tiers, pools, devices, branch bookkeeping."""
    report = service.inventory(cfg, with_devices=bool(params.get("devices", True)))
    tiers = report["tiers"]
    note = "; ".join(f"{name}: {info['health']}" for name, info in sorted(tiers.items()))
    return report, note


# --------------------------------------------------------------------------- mutating


def create_pool(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Initialize a NEW ZFS pool on selected disks. DESTROYS everything on them.

    Requires ``confirm: true``. ``force: true`` is additionally needed to wipe a disk that already
    holds a filesystem, partition table, or ZFS label.
    """
    if params.get("confirm") is not True:
        raise StorageConfigError(
            "creating a ZFS pool erases the selected disks; the request must set confirm=true"
        )
    pool = validate_pool_name(params.get("pool"))
    result = poolinv.create_pool(
        pool,
        params.get("devices") or [],
        vdev_type=poolinv.validate_vdev_type(params.get("vdev_type")),
        force=params.get("force") is True,
    )
    note = f"created ZFS pool '{pool}' on {', '.join(result['devices'])}"
    if params.get("tier"):
        attached, attach_note = attach_pool(cfg, {"tier": params["tier"], "pool": pool})
        return {"created": result, "attached": attached}, f"{note}; {attach_note}"
    return {"created": result, "attached": None}, note


def attach_pool(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Add an existing pool to a tier and extend every existing lab onto it, quota-neutrally."""
    tier = _tier(params)
    pool = validate_pool_name(params.get("pool"))
    old_tier = cfg.storage.tier(tier)

    # Complete the cheap, read-only preflight before installing anything.  This avoids changing a
    # host in response to a request that cannot possibly be applied.
    if pool in old_tier.pools:
        raise StorageConfigError(f"pool '{pool}' already backs the {tier} tier")
    if not zfs.pool_exists(pool):
        raise StorageConfigError(f"ZFS pool '{pool}' is not imported")
    claimed = [name for name in ("fast", "cold") if pool in cfg.storage.tier(name).pools]
    if claimed:
        raise StorageConfigError(
            f"pool '{pool}' already backs the {claimed[0]} tier and cannot back two lab tiers"
        )

    # Day-one single-pool nodes do not install FUSE unnecessarily. The second-drive workflow is
    # therefore responsible for installing mergerfs before it moves any live dataset mountpoint.
    from .hostprep import ensure_mergerfs_available

    ensure_mergerfs_available()

    # Promoting a live one-pool tier changes its ZFS mountpoints. Stop only containers that are
    # running so ZFS can detach cleanly; starting them after mergerfs exists makes Docker rebuild
    # the same stable bind source. Third/later pools normally join through mergerfs' live xattr and
    # do not interrupt containers.
    from .executors import docker

    stopped: list[str] = []
    try:
        # Inside the try: stopping is itself fallible, and a failure on the third lab must not
        # leave the first two down with nothing to bring them back up.
        if not old_tier.uses_mergerfs:
            for lab in service.discover_labs(old_tier):
                name = docker.container_name(lab, cfg.node_name)
                if docker.container_running(name):
                    docker.stop_container(name)
                    stopped.append(lab)
        result = service.attach_pool(cfg, tier, pool)
    except Exception:
        for lab in stopped:
            try:
                docker.start_container(docker.container_name(lab, cfg.node_name))
            except docker.DockerError:
                pass
        raise
    result["config_written"] = _persist(cfg)
    restart_errors: list[str] = []
    restarted: list[str] = []
    for lab in stopped:
        try:
            docker.start_container(docker.container_name(lab, cfg.node_name))
            restarted.append(lab)
        except docker.DockerError as exc:
            restart_errors.append(f"{lab}: {exc}")

    # A failed live branch update falls back to a remount. Restart only affected running labs so
    # their mount namespaces see the replacement union.
    for lab in (result.get("restart_required") or []):
        if lab in stopped:
            continue
        name = docker.container_name(lab, cfg.node_name)
        if not docker.container_running(name):
            continue
        try:
            docker.restart_container(name)
            restarted.append(lab)
        except docker.DockerError as exc:
            restart_errors.append(f"{lab}: {exc}")
    result["containers_restarted"] = sorted(set(restarted))
    result["container_restart_errors"] = restart_errors
    note = (
        f"attached pool '{pool}' to the {tier} tier "
        f"({len(result.get('labs', []))} lab(s) extended)"
    )
    if restarted:
        note += f"; restarted containers: {', '.join(sorted(set(restarted)))}"
    if restart_errors:
        note += "; STORAGE ATTACHED but container restart failed: " + "; ".join(restart_errors)
    failed_labs = [r["lab"] for r in result.get("labs", []) if not r.get("ok")]
    if failed_labs:
        note += "; PARTIAL — branches were not added for: " + ", ".join(failed_labs)
    return result, note


def rebalance(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Recompute + reapply branch quota splits. Moves quota, never files.

    ``min_delta_bytes`` is a deadband: a lab whose branch targets all moved by less than it is left
    alone and reported as unchanged. The controller sends its configured value on SCHEDULED runs so
    an hourly pass does not rewrite (and log) every quota over sub-gigabyte drift in pool free
    space; a hand-triggered rebalance sends 0, meaning "re-slice exactly, I asked for this".

    The note deliberately summarises rather than listing every lab. Over-commit is a standing
    condition only an admin can clear, so it names the labs that JUST became over-committed and
    counts the ones that already were.
    """
    tiers = [_tier(params)] if params.get("tier") else [t.name for t in cfg.storage.tiers()]
    labs = params.get("labs")
    if labs is not None and (not isinstance(labs, list)
                             or not all(isinstance(x, str) for x in labs)):
        raise StorageConfigError("labs must be a list of lab names")
    min_delta = params.get("min_delta_bytes", 0)
    if isinstance(min_delta, bool) or not isinstance(min_delta, int) or min_delta < 0:
        raise StorageConfigError("min_delta_bytes must be a non-negative integer")
    results = [service.rebalance(cfg, name, labs, min_delta=min_delta) for name in tiers]

    entries = [lab for r in results for lab in r.get("labs", [])]
    changed = [e for e in entries if e.get("ok") and e.get("changed")]
    failed = [e for e in entries if not e.get("ok")]
    newly_over = sorted(
        e["lab"] for e in entries if e.get("over_committed") and e.get("over_committed_changed")
    )
    still_over = sum(
        1 for e in entries if e.get("over_committed") and not e.get("over_committed_changed")
    )
    note = f"rebalanced {len(changed)} of {len(entries)} lab(s)"
    if len(entries) - len(changed) - len(failed) > 0:
        note += f"; {len(entries) - len(changed) - len(failed)} already balanced"
    if newly_over:
        note += "; NEWLY over-committed: " + ", ".join(newly_over)
    if still_over:
        note += f"; {still_over} lab(s) still over-committed"
    if failed:
        note += "; FAILED: " + ", ".join(sorted(e["lab"] for e in failed))
    return {"tiers": results}, note


def mount(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Reconcile every tier's ZFS roots and per-lab union mounts. Idempotent."""
    report = service.reconcile_mounts(cfg)
    note = (
        f"{len(report['mounted'])} mount(s) converged, "
        f"{len(report['degraded'])} degraded, {len(report['failed'])} failed"
    )
    return report, note


def provision_lab_storage(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Converge one lab's storage on one tier (used by retry/repair flows)."""
    tier = _tier(params)
    lab = params["lab"]
    quota = params.get("quota_bytes")
    if quota is not None and (isinstance(quota, bool) or not isinstance(quota, int) or quota <= 0):
        raise StorageConfigError("quota_bytes must be a positive integer")
    result = service.provision_lab(cfg, tier, lab, quota)
    return result, f"converged {tier} storage for lab '{lab}'"


def remove_pool(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Detach a pool from a tier: an explicit ADMIN decision, distinct from "the disk vanished".

    Only the membership is changed here — no dataset is destroyed. Marking the pool removed releases
    the quota its branches were reserving, so the next rebalance may hand that capacity to the
    surviving branches. Refused while the pool is still imported and holding lab data, unless
    ``confirm`` is set, because that data would become unreachable through the union.
    """
    tier_name = _tier(params)
    pool = validate_pool_name(params.get("pool"))
    tier = cfg.storage.tier(tier_name)
    if pool not in tier.pools:
        raise StorageConfigError(f"pool '{pool}' does not back the {tier_name} tier")
    if len(tier.pools) == 1:
        raise StorageConfigError(
            f"'{pool}' is the only pool of the {tier_name} tier; removing it would leave the tier "
            "with no storage"
        )
    if zfs.pool_exists(pool) and params.get("confirm") is not True:
        holders = [
            lab for lab in service.discover_labs(tier)
            if zfs.dataset_exists(tier.branch_dataset(pool, lab))
        ]
        if holders:
            raise StorageConfigError(
                f"pool '{pool}' still holds data for: {', '.join(holders)}. Drain or accept the "
                "loss of access explicitly (confirm=true) before detaching it."
            )
    remaining = tuple(p for p in tier.pools if p != pool)
    cfg.storage = cfg.storage.with_tier(tier.with_pools(remaining))
    state = StorageState.load(cfg.storage_state_path)
    state.mark_pool_removed(pool, now_ms=int(time.time() * 1000))
    state.save()
    written = _persist(cfg)
    # Rebuild the unions without the removed branch. Where the branch could not be dropped live the
    # union was remounted, so the running container still holds the OLD mount in its namespace --
    # and would keep writing through the branch we just detached until it is restarted.
    report = service.reconcile_mounts(cfg)
    restarted, restart_errors = _restart_remounted_labs(cfg, report)
    msg = f"detached pool '{pool}' from the {tier_name} tier; its quota reservation is released"
    if restarted:
        msg += f"; restarted containers: {', '.join(restarted)}"
    if restart_errors:
        msg += "; POOL DETACHED but container restart failed: " + "; ".join(restart_errors)
    return (
        {"tier": tier_name, "pool": pool, "pools": list(remaining), "mounts": report,
         "config_written": written, "containers_restarted": restarted,
         "container_restart_errors": restart_errors},
        msg,
    )


def _restart_remounted_labs(
    cfg: AgentConfig, report: dict[str, Any],
) -> tuple[list[str], list[str]]:
    """Restart the running containers of every lab ``reconcile_mounts`` had to remount.

    A live branch add/remove is invisible to an already-running container, but the remount fallback
    replaces the mount entirely; only a restart makes the container's namespace see it.
    """
    from .executors import docker

    labs = sorted({
        entry["lab"] for entry in report.get("degraded", [])
        if entry.get("restart_required") and entry.get("lab")
    })
    restarted: list[str] = []
    errors: list[str] = []
    for lab in labs:
        name = docker.container_name(lab, cfg.node_name)
        if not docker.container_running(name):
            continue
        try:
            docker.restart_container(name)
            restarted.append(lab)
        except docker.DockerError as exc:
            errors.append(f"{lab}: {exc}")
    return restarted, errors


def scrub(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Start a scrub on every locally owned pool (or the requested subset)."""
    from . import maintenance

    return maintenance.run_scrub(cfg, params)
