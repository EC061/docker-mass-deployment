"""Lab storage operations: provision/destroy a lab's storage and adjust quotas live.

These are dispatcher handlers (signature ``(cfg, params) -> (result, logs)``). Storage is handled
through ``storage.service``, so a tier backed by one ZFS pool and a tier backed by four pools behind
a per-lab mergerfs union take the exact same code path — and the container mount points
(``/fast/<lab>``, ``/cold-storage/<lab>``) are identical either way.
"""

from __future__ import annotations

from typing import Any

from . import coldstore
from .config import AgentConfig
from .executors import zfs
from .storage import service
from .storage.model import TIER_COLD, TIER_FAST


def _usage_dict(u: zfs.Usage) -> dict[str, Any]:
    return {
        "dataset": u.dataset,
        "used_bytes": u.used_bytes,
        "quota_bytes": u.quota_bytes,
        "available_bytes": u.available_bytes,
    }


def _fast_usage(cfg: AgentConfig, lab: str) -> zfs.Usage:
    """One aggregated fast-tier usage row for the lab (summed across branches)."""
    tier = cfg.storage.fast
    agg = service.aggregate(TIER_FAST, lab, service.observe_branches(tier, lab))
    return zfs.Usage(tier.logical_mount(lab), agg.used_bytes, agg.quota_bytes, agg.available_bytes)


def create_lab(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    fast_quota = params.get("fast_quota_bytes")
    slow_quota = params.get("slow_quota_bytes")

    from . import containerops

    containerops.assert_node_ready(cfg)

    # One quota-bearing dataset per POOL per tier, sharing the lab's single logical quota, plus the
    # per-lab union mount when the tier spans more than one pool. Managed labs use --userns=host, so
    # container root owns the lab mount roots as host uid 0.
    fast = service.provision_lab(cfg, TIER_FAST, lab, fast_quota, uid=0, gid=0, mode=0o711)
    cold_note = coldstore.create_lab(cfg, lab, slow_quota)

    # Provision the shared container (no-op if Docker absent -> reported as failure upstream).
    container = containerops.ensure_container(cfg, lab, params)

    result = {
        "lab": lab,
        "container": container,
        "fast": _usage_dict(_fast_usage(cfg, lab)),
        "slow": _usage_dict(coldstore.lab_usage(cfg, lab)),
        "fast_allocation": fast.get("allocation"),
        "fast_mountpoint": fast.get("mountpoint"),
    }
    logs = "; ".join([f"provisioned storage + container for lab '{lab}'", cold_note,
                      *fast.get("logs", [])])
    return result, logs


def set_lab_quota(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    logs = []
    if "fast_quota_bytes" in params:
        result = service.set_lab_quota(cfg, TIER_FAST, lab, params["fast_quota_bytes"])
        split = ", ".join(f"{p}={q}" for p, q in sorted(result.get("allocation", {}).items()))
        logs.append(f"fast quota -> {params['fast_quota_bytes']} ({split or 'no branch'})")
        logs += [w for w in result.get("logs", []) if w.startswith(("PARTIAL", "configured"))]
    if "slow_quota_bytes" in params:
        logs.append(coldstore.set_lab_quota(cfg, lab, params["slow_quota_bytes"]))
    result = {
        "lab": lab,
        "fast": _usage_dict(_fast_usage(cfg, lab)),
        "slow": _usage_dict(coldstore.lab_usage(cfg, lab)),
    }
    return result, "; ".join(logs) or "no quota change requested"


def destroy_lab(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    force = bool(params.get("force", False))
    # Remove the container FIRST. Its bind mounts keep the lab storage busy, so unmounting the
    # mergerfs union and `zfs destroy -r` both fail ("dataset is busy") while the container exists.
    # The container's data lives in the datasets (not its writable layer), so removing it loses
    # nothing the teardown isn't already destroying.
    from .executors import docker

    # Pre-flight EVERY tier before touching anything. Destruction is ordered container -> fast ->
    # cold, so a missing cold branch discovered at the last step would otherwise have already cost
    # the container and every student home while reporting that it refused to destroy anything.
    service.assert_destroyable(cfg, TIER_FAST, lab, force=force)
    if cfg.slow_is_zfs:
        service.assert_destroyable(cfg, TIER_COLD, lab, force=force)

    docker.remove_container(docker.container_name(lab, cfg.node_name))
    logs = service.destroy_lab(cfg, TIER_FAST, lab, force=force)
    coldstore.destroy_lab(cfg, lab, force=force)
    return {"lab": lab, "destroyed": True, "logs": logs}, (
        f"destroyed container + storage for lab '{lab}'"
    )
