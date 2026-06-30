"""Lab storage operations: provision/destroy a lab's ZFS datasets and adjust quotas live.

These are dispatcher handlers (signature ``(cfg, params) -> (result, logs)``). Container creation
and student users are handled in phase 3; here we only manage storage.
"""

from __future__ import annotations

from typing import Any

from . import coldstore
from .config import AgentConfig
from .executors import zfs
from .paths import (
    fast_mount,
    lab_fast,
)


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

    from . import containerops

    containerops.assert_node_ready(cfg)

    # One quota-bearing dataset per tier. The fast dataset has an explicit, stable host mountpoint;
    # cold storage goes through the local-ZFS/SMB abstraction.
    zfs.create_dataset(
        lab_fast(cfg, lab), quota_bytes=fast_quota, mountpoint=fast_mount(cfg, lab)
    )
    coldstore.create_lab(cfg, lab, slow_quota)

    # With Docker userns-remap, container root is a high host uid. It owns each lab mount root so it
    # can administer users inside the container without gaining host-root ownership.
    from .executors import coldfs

    coldfs.ensure_owned_dir(zfs.get_mountpoint(lab_fast(cfg, lab)), cfg.userns_start,
                            cfg.userns_start, mode=0o711)
    coldfs.ensure_owned_dir(coldstore.lab_mount(cfg, lab), cfg.userns_start,
                            cfg.userns_start, mode=0o711)

    # Provision the shared container (no-op if Docker absent -> reported as failure upstream).
    container = containerops.ensure_container(cfg, lab, params)

    result = {
        "lab": lab,
        "container": container,
        "fast": _usage_dict(zfs.get_usage(lab_fast(cfg, lab))),
        "slow": _usage_dict(coldstore.lab_usage(cfg, lab)),
    }
    return result, f"provisioned datasets + container for lab '{lab}'"


def set_lab_quota(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    logs = []
    if "fast_quota_bytes" in params:
        zfs.set_quota(lab_fast(cfg, lab), params["fast_quota_bytes"])
        logs.append(f"fast quota -> {params['fast_quota_bytes']}")
    if "slow_quota_bytes" in params:
        logs.append(coldstore.set_lab_quota(cfg, lab, params["slow_quota_bytes"]))
    result = {
        "lab": lab,
        "fast": _usage_dict(zfs.get_usage(lab_fast(cfg, lab))),
        "slow": _usage_dict(coldstore.lab_usage(cfg, lab)),
    }
    return result, "; ".join(logs) or "no quota change requested"


def destroy_lab(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    lab = params["lab"]
    # Remove the container FIRST. Its bind mounts keep the lab datasets
    # datasets busy, so `zfs destroy -r` fails ("dataset is busy") while the container exists. The
    # container's data lives in the datasets (not its writable layer), so removing it loses nothing
    # the teardown isn't already destroying.
    from .executors import docker

    docker.remove_container(docker.container_name(lab))
    zfs.destroy_dataset(lab_fast(cfg, lab), recursive=True)
    coldstore.destroy_lab(cfg, lab)
    return {"lab": lab, "destroyed": True}, f"destroyed container + datasets for lab '{lab}'"
