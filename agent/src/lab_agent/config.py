"""Agent configuration: load/save a small TOML file.

The config is written by `lab-agent install` and read by `lab-agent run`. The controller remains the
source of truth for *operational* settings (quotas, GPU policy, thresholds); this file carries node
identity, the controller connection, and the **safety-critical local storage topology** the node
must understand before it can talk to anyone.

Three kinds of value live in this system, and they are deliberately separated:

1. **Bootstrap / local-authoritative** (here): controller URL + token, node name, which ZFS pools
   back which tier, tier backends, mount roots, mergerfs defaults, SMB path, the Docker pool. A node
   must be able to import its pools, mount its tiers, and start its containers with the controller
   offline, so these can never live only in the controller.
2. **Controller-authoritative** (never stored here): per-lab quotas, rosters, images, GPU policy,
   scan schedules. Storage *changes* the controller drives (attach a pool, rebalance) are applied by
   the agent and then written back into this file, so the local copy stays the operative truth.
3. **Reported / read-only hardware state** (never stored anywhere as config): pool health, device
   inventory, scrub state, mount state. Always measured live.

Schema, with the legacy single-pool form still accepted:

    [agent]
    controller_url = "wss://controller.example"
    token = "..."
    node_name = "gpu-01"

    [storage.fast]
    backend = "mergerfs"        # or "zfs"
    pools = ["fast1", "fast2"]
    mount_root = "/fast"

    [storage.cold]
    backend = "mergerfs"        # or "zfs" or "smb"
    pools = ["cold1", "cold2"]
    mount_root = "/cold-storage"

    [storage.docker]
    pool = "fast1"              # native ZFS; NEVER mergerfs
    dataset = "docker"
    quota_gb = 1024

Legacy configs using ``fast_pool`` / ``slow_pool`` / ``slow_backend`` / ``slow_path`` /
``cold_mount_root`` load unchanged and are converted into the model above (see
``storage.model.legacy_storage``). Saving rewrites the file in the new schema.
"""

from __future__ import annotations

import os
import socket
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .storage.model import (
    BACKEND_MERGERFS,
    BACKEND_SMB,
    BACKEND_ZFS,
    DEFAULT_COLD_MOUNT_ROOT,
    DEFAULT_COLD_POOL,
    DEFAULT_DOCKER_DATA_ROOT,
    DEFAULT_DOCKER_DATASET_NAME,
    DEFAULT_DOCKER_QUOTA_GB,
    DEFAULT_FAST_MOUNT_ROOT,
    DEFAULT_FAST_POOL,
    GIB,
    StorageConfig,
    StorageConfigError,
    default_storage,
    legacy_storage,
    storage_from_toml,
)

DEFAULT_CONFIG_PATH = Path(os.environ.get("LAB_AGENT_CONFIG", "/etc/lab-agent/config.toml"))

# Re-exported so existing imports (installer, cli, hostprep, tests) keep working.
SLOW_BACKEND_ZFS = BACKEND_ZFS
SLOW_BACKEND_SMB = BACKEND_SMB
SLOW_BACKEND_MERGERFS = BACKEND_MERGERFS

# Docker's native user-namespace mapping uses the same range on every node so numeric
# ownership survives when cold storage is shared over SMB.
DEFAULT_USERNS_USER = "labdockremap"
DEFAULT_USERNS_START = 231_072
DEFAULT_USERNS_SIZE = 65_536
DEFAULT_SECCOMP_PROFILE = "/etc/lab-agent/security/lab-codex-seccomp.json"
DEFAULT_APPARMOR_PROFILE = "lab-codex"

# Legacy scalar keys still accepted in [agent]; each maps into the storage model.
LEGACY_STORAGE_KEYS = (
    "fast_pool",
    "slow_pool",
    "slow_backend",
    "slow_path",
    "fast_mount_root",
    "cold_mount_root",
    "docker_data_root",
    "docker_dataset_name",
    "docker_quota_gb",
)

# Plain scalars that round-trip verbatim through [agent].
AGENT_KEYS = (
    "controller_url",
    "token",
    "node_name",
    "userns_user",
    "userns_start",
    "userns_size",
    "seccomp_profile",
    "apparmor_profile",
    "state_db",
    "heartbeat_interval_s",
    "usage_publish_interval_s",
    "lab_usage_interval_s",
    "usage_scan_interval_s",
    "apt_update_enabled",
    "apt_update_interval_s",
    "apt_update_check_interval_s",
    "apt_update_timeout_s",
    "tls_verify",
)


@dataclass
class AgentConfig:
    controller_url: str
    token: str
    node_name: str = field(default_factory=socket.gethostname)
    # The node's whole storage topology. Built from [storage.*] or from the legacy scalars.
    storage: StorageConfig = field(default_factory=default_storage)
    # Native Docker userns-remap contract. Container uid N maps to userns_start + N on the host.
    userns_user: str = DEFAULT_USERNS_USER
    userns_start: int = DEFAULT_USERNS_START
    userns_size: int = DEFAULT_USERNS_SIZE
    seccomp_profile: str = DEFAULT_SECCOMP_PROFILE
    apparmor_profile: str = DEFAULT_APPARMOR_PROFILE
    # Local cache DB for the durable task buffer + offline event/log buffer.
    state_db: str = "/var/lib/lab-agent/state.db"
    heartbeat_interval_s: int = 15
    # How often the per-lab labquota usage snapshot is republished (live ZFS metadata only — cheap).
    usage_publish_interval_s: int = 120
    # How often the lab-level storage totals (fast/cold ZFS + container writable-layer "image") are
    # recomputed and cached for the controller's Stats page. The heartbeat re-reports the cached
    # snapshot, so this is the real refresh cadence for those numbers — they are NOT measured per
    # heartbeat. An on-demand "Scan now" refreshes them immediately regardless of this interval.
    lab_usage_interval_s: int = 300
    # Fallback cadence for the (expensive) per-student du scan when the agent runs it unprompted,
    # and the freshness gate below which a student-requested refresh is skipped as "already fresh".
    usage_scan_interval_s: int = 86400
    # Weekly in-container security patching (docker exec apt-get update && upgrade).
    apt_update_enabled: bool = True
    apt_update_interval_s: int = 604800  # per-lab patch cadence (default weekly)
    apt_update_check_interval_s: int = 3600  # how often the loop wakes to see what is due
    apt_update_timeout_s: int = 1800  # ceiling for each apt-get update/upgrade call
    # TLS verification can be disabled for self-signed controllers on a trusted LAN.
    tls_verify: bool = True

    # ------------------------------------------------------------------ storage conveniences
    @property
    def fast_tier(self):
        return self.storage.fast

    @property
    def cold_tier(self):
        return self.storage.cold

    @property
    def slow_is_zfs(self) -> bool:
        """Whether this node OWNS its cold storage (zfs or mergerfs), rather than being an SMB
        client of another node's pools."""
        return self.storage.cold.is_zfs_owned

    @property
    def slow_backend(self) -> str:
        return self.storage.cold.backend

    @property
    def slow_path(self) -> str:
        return self.storage.cold.cold_root

    @property
    def fast_mount_root(self) -> str:
        return self.storage.fast.mount_root

    @property
    def cold_mount_root(self) -> str:
        return self.storage.cold.mount_root

    @property
    def cold_root(self) -> str:
        """Host root holding per-lab cold directories for either backend."""
        return self.storage.cold.cold_root

    @property
    def docker_data_root(self) -> str:
        return self.storage.docker.data_root

    @property
    def docker_dataset(self) -> str:
        """Full ZFS dataset name backing Docker's data-root (always NATIVE zfs, never mergerfs)."""
        return self.storage.docker.dataset

    @property
    def docker_dataset_name(self) -> str:
        return self.storage.docker.dataset_name

    @property
    def docker_quota_gb(self) -> int:
        return self.storage.docker.quota_gb

    @property
    def scrub_pools(self) -> list[str]:
        """Every ZFS pool this node owns and can scrub. An SMB cold tier contributes none."""
        return self.storage.owned_pools

    @property
    def maintenance_state(self) -> str:
        """Persistent per-lab maintenance bookkeeping file (apt-upgrade timestamps), beside the
        durable state DB so it shares the agent's private state directory."""
        return os.path.join(self.state_dir, "maintenance.json")

    @property
    def state_dir(self) -> str:
        return os.path.dirname(self.state_db) or "/var/lib/lab-agent"

    @property
    def storage_state_path(self) -> str:
        """Persisted branch bookkeeping (which branch owns what quota, what is missing)."""
        return os.path.join(self.state_dir, "storage-state.json")


def _legacy_from_agent_table(agent: dict[str, Any]) -> StorageConfig:
    """Build the storage model from the pre-multi-pool [agent] scalars (all optional)."""
    return legacy_storage(
        fast_pool=agent.get("fast_pool", DEFAULT_FAST_POOL),
        slow_pool=agent.get("slow_pool", DEFAULT_COLD_POOL),
        slow_backend=agent.get("slow_backend", BACKEND_ZFS),
        slow_path=agent.get("slow_path"),
        fast_mount_root=agent.get("fast_mount_root", DEFAULT_FAST_MOUNT_ROOT),
        cold_mount_root=agent.get("cold_mount_root", DEFAULT_COLD_MOUNT_ROOT),
        docker_dataset_name=agent.get("docker_dataset_name", DEFAULT_DOCKER_DATASET_NAME),
        docker_data_root=agent.get("docker_data_root", DEFAULT_DOCKER_DATA_ROOT),
        docker_quota_gb=agent.get("docker_quota_gb", DEFAULT_DOCKER_QUOTA_GB),
    )


def load_config(path: Path | None = None) -> AgentConfig:
    path = path or DEFAULT_CONFIG_PATH
    if not path.exists():
        raise FileNotFoundError(
            f"Agent config not found at {path}. "
            "Run `lab-agent install --controller ... --token ...`."
        )
    with path.open("rb") as fh:
        data = tomllib.load(fh)
    agent = data.get("agent", {})
    try:
        cfg = AgentConfig(
            controller_url=agent["controller_url"],
            token=agent["token"],
        )
    except KeyError as exc:  # pragma: no cover - config validation
        raise ValueError(f"Missing required config key: {exc}") from exc

    unknown = set(agent) - set(AGENT_KEYS) - set(LEGACY_STORAGE_KEYS)
    if unknown:
        raise ValueError(f"[agent] has unknown key(s): {', '.join(sorted(unknown))}")
    for key in AGENT_KEYS:
        if key in agent and agent[key] is not None:
            setattr(cfg, key, agent[key])

    # Legacy scalars first, then any explicit [storage.*] tables layered on top. This lets a config
    # keep `fast_pool = "fast"` while adding only `[storage.cold]` with two pools.
    legacy = _legacy_from_agent_table(agent)
    storage_table = data.get("storage")
    try:
        cfg.storage = (
            storage_from_toml(storage_table, legacy=legacy)
            if storage_table is not None else legacy
        )
    except StorageConfigError as exc:
        raise ValueError(str(exc)) from exc
    return cfg


def _toml_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_toml_value(v) for v in value) + "]"
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _render_tier(tier) -> list[str]:
    lines = [f"\n[storage.{tier.name}]", f"backend = {_toml_value(tier.backend)}"]
    if tier.backend == BACKEND_SMB:
        lines.append(f"path = {_toml_value(tier.cold_root)}")
    else:
        lines.append(f"pools = {_toml_value(list(tier.pools))}")
    lines.append(f"mount_root = {_toml_value(tier.mount_root)}")
    if tier.uses_mergerfs:
        lines.append(f"branch_root = {_toml_value(tier.branch_root)}")
    if tier.dataset_prefix != "labs":
        lines.append(f"dataset_prefix = {_toml_value(tier.dataset_prefix)}")
    if tier.min_branch_headroom_bytes != 16 * GIB:
        lines.append(
            f"min_branch_headroom_bytes = {_toml_value(tier.min_branch_headroom_bytes)}"
        )
    if tier.uses_mergerfs:
        defaults = type(tier.mergerfs)().to_dict()
        options = tier.mergerfs.to_dict()
        changed = {k: v for k, v in options.items() if defaults[k] != v}
        if changed:
            lines.append(f"\n[storage.{tier.name}.mergerfs]")
            lines += [f"{k} = {_toml_value(v)}" for k, v in sorted(changed.items())]
    return lines


def render_config(cfg: AgentConfig) -> str:
    """Render an AgentConfig to TOML in the current schema.

    Saving always writes the ``[storage.*]`` form, so the first ``lab-agent set-token`` (or
    re-install) on a legacy node migrates its config file in place with no operator action. The
    legacy scalars remain accepted on load forever.
    """
    lines = ["[agent]"]
    lines += [f"{key} = {_toml_value(getattr(cfg, key))}" for key in AGENT_KEYS]
    lines += _render_tier(cfg.storage.fast)
    lines += _render_tier(cfg.storage.cold)
    lines += [
        "\n[storage.docker]",
        "# Docker's data-root stays on NATIVE ZFS (storage-driver=zfs) and is never on mergerfs.",
        f"pool = {_toml_value(cfg.storage.docker.pool)}",
        f"dataset = {_toml_value(cfg.storage.docker.dataset_name)}",
        f"data_root = {_toml_value(cfg.storage.docker.data_root)}",
        f"quota_gb = {_toml_value(cfg.storage.docker.quota_gb)}",
    ]
    return "\n".join(lines) + "\n"


def save_config(cfg: AgentConfig, path: Path | None = None) -> Path:
    path = path or DEFAULT_CONFIG_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_config(cfg))
    # Token is a secret; keep the file readable only by its owner.
    path.chmod(0o600)
    return path
