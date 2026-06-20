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


@dataclass
class AgentConfig:
    controller_url: str
    token: str
    node_name: str = field(default_factory=socket.gethostname)
    fast_pool: str = DEFAULT_FAST_POOL
    slow_pool: str = DEFAULT_SLOW_POOL
    # Local cache DB for the durable task buffer + offline event/log buffer.
    state_db: str = "/var/lib/lab-agent/state.db"
    heartbeat_interval_s: int = 15
    # TLS verification can be disabled for self-signed controllers on a trusted LAN.
    tls_verify: bool = True

    @property
    def labs_fast_root(self) -> str:
        return f"{self.fast_pool}/labs"

    @property
    def labs_slow_root(self) -> str:
        return f"{self.slow_pool}/labs"

    @property
    def docker_dataset(self) -> str:
        return f"{self.fast_pool}/docker"


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
        "state_db",
        "heartbeat_interval_s",
        "tls_verify",
    ):
        if key in agent and agent[key] is not None:
            setattr(cfg, key, agent[key])
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
