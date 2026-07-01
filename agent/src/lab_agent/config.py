"""Agent configuration: load/save a small TOML file.

The config is written by `lab-agent install` and read by `lab-agent run`. It is intentionally tiny:
the controller is the source of truth for all operational settings (quotas, GPU policy, thresholds).
Only connection details and node identity live here.
"""

from __future__ import annotations

import os
import socket
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_CONFIG_PATH = Path(os.environ.get("LAB_AGENT_CONFIG", "/etc/lab-agent/config.toml"))

# Dataset roots the agent expects to exist on each node (created during host prep, see root README).
DEFAULT_FAST_POOL = "fast"
DEFAULT_SLOW_POOL = "slow"

# Docker's native user-namespace mapping uses the same range on every node so numeric
# ownership survives when cold storage is shared over SMB.
DEFAULT_USERNS_USER = "labdockremap"
DEFAULT_USERNS_START = 231_072
DEFAULT_USERNS_SIZE = 65_536
DEFAULT_FAST_MOUNT_ROOT = "/fast"
DEFAULT_COLD_MOUNT_ROOT = "/cold-storage"
DEFAULT_DOCKER_DATA_ROOT = "/var/lib/docker"
# Docker's data-root is a native ZFS dataset on the fast pool (storage-driver "zfs"): every image
# layer and container is its own ZFS clone, and its rootfs_quota storage-opt maps straight onto the
# clone's "quota" property. The dataset lives at <fast_pool>/<dataset-name>.
DEFAULT_DOCKER_DATASET_NAME = "docker"
# ZFS "quota" (GiB) applied to the dataset on every host-prepare run; 0 means unlimited (shares the
# rest of the fast pool). Unlike a zvol this is a live property: change it and re-run host-prepare
# to resize immediately, with no unmount/reformat/reboot.
DEFAULT_DOCKER_QUOTA_GB = 1024
DEFAULT_SECCOMP_PROFILE = "/etc/lab-agent/security/lab-codex-seccomp.json"
DEFAULT_APPARMOR_PROFILE = "lab-codex"

# Cold-storage (slow tier) backends:
#   "zfs" — a local ZFS pool on this node; full dataset/quota/scrub control (default).
#   "smb" — an externally-managed SMB/CIFS mount. No ZFS control: directories instead of
#           datasets, no enforceable quota, usage measured with du/statvfs, never scrubbed.
#           The same SMB share may be mounted on more than one node.
SLOW_BACKEND_ZFS = "zfs"
SLOW_BACKEND_SMB = "smb"


@dataclass
class AgentConfig:
    controller_url: str
    token: str
    node_name: str = field(default_factory=socket.gethostname)
    fast_pool: str = DEFAULT_FAST_POOL
    slow_pool: str = DEFAULT_SLOW_POOL
    # Cold-storage backend: "zfs" (default) or "smb".
    slow_backend: str = SLOW_BACKEND_ZFS
    # When slow_backend == "smb", the active mountpoint of the owner's cold-storage share. Lab
    # directories live directly below it (/cold-storage/<lab>).
    slow_path: str = DEFAULT_COLD_MOUNT_ROOT
    # Host mount root for the flattened per-lab fast datasets. A lab is mounted on the host at
    # /fast/<lab> and bind-mounted into its container at /home.
    fast_mount_root: str = DEFAULT_FAST_MOUNT_ROOT
    # Explicit host mount root for locally-owned cold ZFS datasets.
    cold_mount_root: str = DEFAULT_COLD_MOUNT_ROOT
    # Native Docker userns-remap contract. Container uid N maps to userns_start + N on the host.
    userns_user: str = DEFAULT_USERNS_USER
    userns_start: int = DEFAULT_USERNS_START
    userns_size: int = DEFAULT_USERNS_SIZE
    docker_data_root: str = DEFAULT_DOCKER_DATA_ROOT
    # Name of the fast-pool dataset backing the Docker data-root (full name: <fast_pool>/<name>).
    docker_dataset_name: str = DEFAULT_DOCKER_DATASET_NAME
    docker_quota_gb: int = DEFAULT_DOCKER_QUOTA_GB
    seccomp_profile: str = DEFAULT_SECCOMP_PROFILE
    apparmor_profile: str = DEFAULT_APPARMOR_PROFILE
    # Local cache DB for the durable task buffer + offline event/log buffer.
    state_db: str = "/var/lib/lab-agent/state.db"
    heartbeat_interval_s: int = 15
    # How often the per-lab labquota usage snapshot is republished (live ZFS metadata only — cheap).
    usage_publish_interval_s: int = 120
    # How often the lab-level storage totals (fast/slow ZFS + container writable-layer "image") are
    # recomputed and cached for the controller's Stats page. The heartbeat re-reports the cached
    # snapshot, so this is the real refresh cadence for those numbers — they are NOT measured per
    # heartbeat. An on-demand "Scan now" refreshes them immediately regardless of this interval.
    lab_usage_interval_s: int = 300
    # Fallback cadence for the (expensive) per-student du scan when the agent runs it unprompted,
    # and the freshness gate below which a student-requested refresh is skipped as "already fresh".
    # The controller schedules the precise off-peak nightly scan (Settings -> per-student usage
    # scan); this daily fallback just keeps per-student numbers from going fully stale if disabled.
    usage_scan_interval_s: int = 86400
    # Weekly in-container security patching (docker exec apt-get update && upgrade), driven by the
    # agent off a persistent local record so the pinned base image never needs rebuilding for CVEs.
    apt_update_enabled: bool = True
    apt_update_interval_s: int = 604800  # per-lab patch cadence (default weekly)
    apt_update_check_interval_s: int = 3600  # how often the loop wakes to see what is due
    apt_update_timeout_s: int = 1800  # ceiling for each apt-get update/upgrade call
    # TLS verification can be disabled for self-signed controllers on a trusted LAN.
    tls_verify: bool = True

    @property
    def slow_is_zfs(self) -> bool:
        return self.slow_backend != SLOW_BACKEND_SMB

    @property
    def docker_dataset(self) -> str:
        """Full ZFS dataset name backing Docker's data-root."""
        return f"{self.fast_pool}/{self.docker_dataset_name}"

    @property
    def labs_fast_root(self) -> str:
        return f"{self.fast_pool}/labs"

    @property
    def labs_slow_root(self) -> str:
        return f"{self.slow_pool}/labs"

    @property
    def cold_root(self) -> str:
        """Host root holding per-lab cold directories for either backend."""
        root = self.cold_mount_root if self.slow_is_zfs else self.slow_path
        return root.rstrip("/")

    @property
    def maintenance_state(self) -> str:
        """Persistent per-lab maintenance bookkeeping file (apt-upgrade timestamps), beside the
        durable state DB so it shares the agent's private state directory."""
        return os.path.join(os.path.dirname(self.state_db) or ".", "maintenance.json")

    @property
    def scrub_pools(self) -> list[str]:
        """ZFS pools this node owns and can scrub. The slow pool is excluded on SMB cold storage."""
        pools = [self.fast_pool]
        if self.slow_is_zfs:
            pools.append(self.slow_pool)
        return pools


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
    # Optional overrides.
    for key in (
        "node_name",
        "fast_pool",
        "slow_pool",
        "slow_backend",
        "slow_path",
        "fast_mount_root",
        "cold_mount_root",
        "userns_user",
        "userns_start",
        "userns_size",
        "docker_data_root",
        "docker_dataset_name",
        "docker_quota_gb",
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
    ):
        if key in agent and agent[key] is not None:
            setattr(cfg, key, agent[key])
    if cfg.slow_backend not in (SLOW_BACKEND_ZFS, SLOW_BACKEND_SMB):
        raise ValueError(
            f"slow_backend must be '{SLOW_BACKEND_ZFS}' or '{SLOW_BACKEND_SMB}', "
            f"got '{cfg.slow_backend}'"
        )
    return cfg


def _toml_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def render_config(cfg: AgentConfig) -> str:
    """Render an AgentConfig to a TOML string (flat [agent] table)."""
    lines = ["[agent]"]
    for key in (
        "controller_url",
        "token",
        "node_name",
        "fast_pool",
        "slow_pool",
        "slow_backend",
        "slow_path",
        "fast_mount_root",
        "cold_mount_root",
        "userns_user",
        "userns_start",
        "userns_size",
        "docker_data_root",
        "docker_dataset_name",
        "docker_quota_gb",
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
    ):
        lines.append(f"{key} = {_toml_value(getattr(cfg, key))}")
    return "\n".join(lines) + "\n"


def save_config(cfg: AgentConfig, path: Path | None = None) -> Path:
    path = path or DEFAULT_CONFIG_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_config(cfg))
    # Token is a secret; keep the file readable only by its owner.
    path.chmod(0o600)
    return path
