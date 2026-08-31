"""Create exact-ID accounts and conditional per-student storage datasets.

Quota-disabled placements retain the original host-owned directories: the student's directory is
made once on the lab's logical mount and mergerfs (or plain ZFS) places it. A placement WITH a
student quota promotes that directory to a real dataset per branch, so the limit is enforced by ZFS
rather than watched — and the student's single logical quota is sharded across the branches by the
same allocator the lab quota uses, so ``sum(branch quota) <= configured student quota`` holds there
too.
"""

from __future__ import annotations

import os
import shutil
from typing import Any

from . import coldstore
from .config import AgentConfig
from .executors import coldfs, docker, users, zfs
from .executors.base import run
from .storage import service
from .storage.model import TIER_COLD, TIER_FAST, TierConfig
from .storage.quota import BranchState, allocate


def _dir_bytes(path: str) -> int:
    """Apparent size of a directory, used only as the promotion floor for a student quota."""
    res = run(["du", "-sb", "--", path], timeout=600)
    if not res.ok or not res.stdout.strip():
        return 0
    try:
        return int(res.stdout.split()[0])
    except (ValueError, IndexError):
        return 0


def _ensure_user_dataset(dataset: str, path: str, quota: int | None, uid: int, gid: int) -> None:
    """Create/promote a student directory only when quota mode is enabled.

    With quota unset and no existing child dataset this intentionally does nothing beyond ownership,
    preserving the original flat lab dataset. Promotion is called while the lab container is stopped
    by recreate.
    """
    if zfs.dataset_exists(dataset):
        zfs.set_quota(dataset, quota)
        coldfs.ensure_owned_dir(path, uid, gid)
        return
    if quota is None:
        coldfs.ensure_owned_dir(path, uid, gid)
        return
    staged = f"{path}.student-quota-migration"
    had_data = os.path.exists(path)
    if os.path.exists(staged):
        raise RuntimeError(f"stale student quota migration path exists: {staged}")
    if had_data:
        os.rename(path, staged)
    try:
        # The quota is applied at creation, so the dataset is never momentarily unlimited.
        #
        # The mountpoint is deliberately INHERITED rather than pinned to `path`: a child inherits
        # "parent's mountpoint + its own name", which is `path` exactly, and an inherited mountpoint
        # then follows the lab branch wherever it moves. A pinned one does not — that is what left
        # every per-student dataset stranded and unmounted when a cold tier was promoted to
        # mergerfs. The result is verified below rather than assumed.
        zfs.create_dataset(dataset, quota_bytes=quota)
        actual = zfs.get_mountpoint(dataset)
        if actual.rstrip("/") != path.rstrip("/"):
            raise RuntimeError(
                f"student dataset {dataset} inherited mountpoint {actual}, expected {path}"
            )
        if had_data:
            copied = run(["cp", "-a", f"{staged}/.", path], timeout=3600)
            if not copied.ok:
                raise RuntimeError(f"could not copy student data into quota dataset: {copied.logs}")
        coldfs.ensure_owned_dir(path, uid, gid)
        if had_data:
            shutil.rmtree(staged)
    except Exception:
        if zfs.dataset_exists(dataset):
            zfs.destroy_dataset(dataset, recursive=True)
        if had_data and os.path.exists(staged):
            if os.path.isdir(path) and not os.listdir(path):
                os.rmdir(path)
            os.rename(staged, path)
        raise


def _student_allocation(
    tier: TierConfig, lab: str, user: str, quota: int, branches: list[service.BranchObservation]
) -> dict[str, int]:
    """Split one student's logical tier quota across the branches that are actually present.

    Same invariants as the lab-level split: never below what the branch already holds, never more in
    total than the configured student quota, never handing a missing branch's share to a survivor.
    """
    missing = [obs.pool for obs in branches if not obs.present]
    if missing:
        # Student allocations pre-date the storage state file and are not individually persisted.
        # Without the missing dataset mounted we cannot know its last hard quota, so reallocating
        # any of that budget to a survivor could exceed the student's quota when the disk returns.
        # Existing datasets keep their current enforcement; an administrator can retry once the
        # branch is recovered or explicitly removed.
        raise service.StorageError(
            f"{tier.name} branch(es) {', '.join(missing)} of lab '{lab}' are unavailable; "
            "refusing to redistribute a per-student quota while their allocation is unknown"
        )

    states: list[BranchState] = []
    for obs in branches:
        dataset = f"{obs.dataset}/{user}"
        path = f"{obs.path}/{user}"
        if not obs.present:
            states.append(BranchState(pool=obs.pool, used=0, quota=None, pool_free=0,
                                      available=False))
            continue
        if zfs.dataset_exists(dataset):
            usage = zfs.get_usage(dataset)
            used, current = usage.used_bytes, usage.quota_bytes
        else:
            used, current = (_dir_bytes(path) if os.path.isdir(path) else 0), None
        states.append(BranchState(pool=obs.pool, used=used, quota=current,
                                  pool_free=obs.pool_free, available=True))
    return allocate(quota, states, min_headroom=0).quotas


def _prepare_tier(
    cfg: AgentConfig, tier_name: str, lab: str, username: str, uid: int, gid: int,
    quota: int | None,
) -> None:
    tier = cfg.storage.tier(tier_name)
    branches = service.observe_branches(tier, lab)
    present = [b for b in branches if b.present]
    if not present:
        raise service.StorageError(
            f"no {tier_name} branch of lab '{lab}' is mounted; refusing to create student storage"
        )
    if quota is None:
        # No per-student dataset: one directory on the LOGICAL mount, so mergerfs's create policy
        # places it and every branch stays consistent. Also converge any branch that already has a
        # promoted dataset (a placement that turned student quotas back off).
        logical = tier.logical_mount(lab)
        coldfs.ensure_owned_dir(f"{logical}/{username}", uid, gid)
        for obs in present:
            dataset = f"{obs.dataset}/{username}"
            if zfs.dataset_exists(dataset):
                zfs.set_quota(dataset, None)
        return
    allocation = _student_allocation(tier, lab, username, quota, branches)
    skipped: list[str] = []
    for obs in present:
        target = allocation.get(obs.pool, 0)
        if target <= 0:
            # No positive quota is backable here: either the pool has no free space, or the
            # student's logical quota is already fully committed to the data on their other
            # branches. ZFS has no zero quota, so passing this through would raise. Mirror the
            # lab-level rule in storage.service.apply_allocation instead: never create an
            # unbounded dataset, and leave an existing one at whatever finite quota it holds.
            skipped.append(obs.pool)
            continue
        _ensure_user_dataset(
            f"{obs.dataset}/{username}", f"{obs.path}/{username}", target, uid, gid,
        )
    if len(skipped) == len(present):
        raise service.StorageError(
            f"cannot give '{username}' {tier_name} storage in lab '{lab}': no branch "
            f"({', '.join(skipped)}) has the free capacity to back a positive quota"
        )


def prepare_student_storage(cfg: AgentConfig, lab: str, username: str, uid: int, gid: int,
                            fast_quota: int | None, cold_quota: int | None) -> None:
    users.validate_username(username)
    for label, value in (("fast", fast_quota), ("cold", cold_quota)):
        invalid = value is not None and (
            not isinstance(value, int) or isinstance(value, bool) or value <= 0
        )
        if invalid:
            raise ValueError(f"student {label} quota must be a positive integer byte count")
    _prepare_tier(cfg, TIER_FAST, lab, username, uid, gid, fast_quota)
    if cfg.slow_is_zfs:
        _prepare_tier(cfg, TIER_COLD, lab, username, uid, gid, cold_quota)
    else:
        cold_root = coldstore.lab_mount(cfg, lab)
        coldfs.ensure_owned_dir(f"{cold_root}/{username}", uid, gid)


def add_student(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    username = params["username"]
    password = params["password"]
    uid = int(params["uid"])
    gid = int(params.get("gid", uid))
    users.validate_username(username)
    users.validate_uid(uid, gid)

    # Managed labs use --userns=host, so persistent storage has identical host/container IDs.
    host_uid = uid
    host_gid = gid
    prepare_student_storage(
        cfg, lab, username, host_uid, host_gid,
        params.get("student_fast_quota_bytes"), params.get("student_cold_quota_bytes"),
    )

    # The directories already have the student's stable IDs; account creation populates the home
    # and creates its cold-storage symlink.
    users.add_user(docker.container_name(lab, cfg.node_name), username, password, uid, gid)
    users.verify_ssh_login(docker.container_name(lab, cfg.node_name), username, password)
    return {"lab": lab, "username": username, "uid": uid, "ssh_verified": True}, (
        f"added student '{username}' (uid={uid}) to lab '{lab}'; initial SSH login verified"
    )


def _delete_student_branches(cfg: AgentConfig, tier_name: str, lab: str, username: str) -> None:
    """Remove one student's storage from EVERY branch of a tier.

    Refuses while any branch is unavailable: deleting the survivors while a disk is out would leave
    a copy behind with nothing recording that it should have gone.
    """
    tier = cfg.storage.tier(tier_name)
    branches = service.observe_branches(tier, lab)
    missing = [b.pool for b in branches if not b.pool_usable]
    if missing:
        raise service.StorageError(
            f"{tier_name} branch(es) {', '.join(missing)} of lab '{lab}' are unavailable; "
            "refusing to delete student data while part of it is unreachable"
        )
    for obs in branches:
        dataset = f"{obs.dataset}/{username}"
        if zfs.dataset_exists(dataset):
            zfs.destroy_dataset(dataset, recursive=True)
        else:
            coldfs.remove_child(obs.path, username)


def remove_student(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    username = params["username"]
    delete_data = bool(params.get("delete_data", False))
    users.validate_username(username)
    users.remove_user(docker.container_name(lab, cfg.node_name), username)
    if delete_data:
        _delete_student_branches(cfg, TIER_FAST, lab, username)
    msg = f"removed student '{username}' from lab '{lab}'"
    result = {
        "lab": lab,
        "username": username,
        "data_deleted": delete_data,
        "cold_deleted": False,
    }
    return result, msg


def delete_cold_student(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Owner-only final cleanup after all containers have removed the student account."""
    if not cfg.slow_is_zfs:
        raise coldfs.ColdFsError("an SMB client may not delete shared cold-storage data")
    lab = params["lab"]
    username = params["username"]
    users.validate_username(username)
    _delete_student_branches(cfg, TIER_COLD, lab, username)
    return {"lab": lab, "username": username, "cold_deleted": True}, (
        f"deleted cold storage for '{username}' in lab '{lab}'"
    )
