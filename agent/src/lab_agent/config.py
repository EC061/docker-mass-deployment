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

# Cold-storage (slow tier) backends:
#   "zfs" — a local ZFS pool on this node; full dataset/quota/scrub control (default).
#   "smb" — an externally-managed SMB/CIFS mount. No ZFS control: directories instead of
#           datasets, no enforceable quota, usage measured with du/statvfs, never scrubbed.
#           The same SMB share may be mounted on more than one node (set slow_shared).
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
    # When slow_backend == "smb", the base mount path of the cold-storage share (labs live under
    # <slow_path>/labs/...). Ignored for the zfs backend.
    slow_path: str = "/mnt/cold"
    # True when the cold-storage share is mounted on more than one node. Purely advisory + a safety
    # signal: the agent only ever touches its own labs' sub-directories, never the shared root, and
    # SMB cold storage is never scrubbed.
    slow_shared: bool = False
    # Local cache DB for the durable task buffer + offline event/log buffer.
    state_db: str = "/var/lib/lab-agent/state.db"
    heartbeat_interval_s: int = 15
    # TLS verification can be disabled for self-signed controllers on a trusted LAN.
    tls_verify: bool = True

    @property
    def slow_is_zfs(self) -> bool:
        return self.slow_backend != SLOW_BACKEND_SMB

    @property
    def labs_fast_root(self) -> str:
        return f"{self.fast_pool}/labs"

    @property
    def labs_slow_root(self) -> str:
        return f"{self.slow_pool}/labs"

    @property
    def cold_root(self) -> str:
        """Filesystem root holding labs on an SMB cold-storage mount (smb backend only)."""
        return f"{self.slow_path.rstrip('/')}/labs"

    @property
    def docker_dataset(self) -> str:
        return f"{self.fast_pool}/docker"

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
        "slow_shared",
        "state_db",
        "heartbeat_interval_s",
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
        "slow_shared",
        "state_db",
        "heartbeat_interval_s",
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
