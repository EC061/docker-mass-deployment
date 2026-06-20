"""Lab storage operations: provision/destroy a lab's ZFS datasets and adjust quotas live.

These are dispatcher handlers (signature ``(cfg, params) -> (result, logs)``). Container creation
and student users are handled in phase 3; here we only manage storage.
"""

from __future__ import annotations

from typing import Any

from .config import AgentConfig
from .executors import zfs
from .paths import lab_fast, lab_fast_shared, lab_slow, lab_slow_shared


def _usage_dict(u: zfs.Usage) -> dict[str, Any]:
    return {
        "dataset": u.dataset,
        "used_bytes": u.used_bytes,
        "quota_bytes": u.quota_bytes,
        "available_bytes": u.available_bytes,
    }


def create_lab(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    fast_quota = params.get("fast_quota_bytes")
    slow_quota = params.get("slow_quota_bytes")

    # Parent datasets carry the lab quota; shared datasets hold lab-wide data.
    zfs.create_dataset(lab_fast(cfg, lab), quota_bytes=fast_quota)
    zfs.create_dataset(lab_slow(cfg, lab), quota_bytes=slow_quota)
    zfs.create_dataset(lab_fast_shared(cfg, lab))
    zfs.create_dataset(lab_slow_shared(cfg, lab))

    result = {
        "lab": lab,
        "fast": _usage_dict(zfs.get_usage(lab_fast(cfg, lab))),
        "slow": _usage_dict(zfs.get_usage(lab_slow(cfg, lab))),
    }
    return result, f"provisioned datasets for lab '{lab}'"


def set_lab_quota(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    logs = []
    if "fast_quota_bytes" in params:
        zfs.set_quota(lab_fast(cfg, lab), params["fast_quota_bytes"])
        logs.append(f"fast quota -> {params['fast_quota_bytes']}")
    if "slow_quota_bytes" in params:
        zfs.set_quota(lab_slow(cfg, lab), params["slow_quota_bytes"])
        logs.append(f"slow quota -> {params['slow_quota_bytes']}")
    result = {
        "lab": lab,
        "fast": _usage_dict(zfs.get_usage(lab_fast(cfg, lab))),
        "slow": _usage_dict(zfs.get_usage(lab_slow(cfg, lab))),
    }
    return result, "; ".join(logs) or "no quota change requested"


def destroy_lab(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    zfs.destroy_dataset(lab_fast(cfg, lab), recursive=True)
    zfs.destroy_dataset(lab_slow(cfg, lab), recursive=True)
    return {"lab": lab, "destroyed": True}, f"destroyed datasets for lab '{lab}'"
