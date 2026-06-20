"""`lab-agent install`: write the config file and a systemd unit so the agent runs on boot.

Designed for the 1-2 line install in the root README:

    uvx --from git+https://github.com/EC061/docker-mass-deployment#subdirectory=agent \
        lab-agent install --controller wss://CONTROLLER:PORT --token TOKEN
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from .config import AgentConfig, save_config

SYSTEMD_UNIT_PATH = Path("/etc/systemd/system/lab-agent.service")
STATE_DIR = Path("/var/lib/lab-agent")


def _resolve_executable() -> str:
    """Absolute path to the lab-agent entrypoint for the systemd ExecStart line."""
    exe = shutil.which("lab-agent")
    if exe:
        return exe
    # Installed transiently via uvx: fall back to `python -m`.
    return f"{sys.executable} -m lab_agent.cli"


def render_unit(config_path: Path) -> str:
    exec_start = f"{_resolve_executable()} run"
    return f"""[Unit]
Description=Lab Manager node agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
Environment=LAB_AGENT_CONFIG={config_path}
ExecStart={exec_start}
Restart=always
RestartSec=5
# The agent shells out to zfs/docker/useradd, which require root.
User=root

[Install]
WantedBy=multi-user.target
"""


def install(cfg: AgentConfig, config_path: Path, *, enable: bool = True) -> dict[str, str]:
    if os.geteuid() != 0:
        raise PermissionError("install must run as root (writes /etc and a systemd unit)")
    saved = save_config(cfg, config_path)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    SYSTEMD_UNIT_PATH.write_text(render_unit(saved))

    results = {"config": str(saved), "unit": str(SYSTEMD_UNIT_PATH)}
    if enable:
        os.system("systemctl daemon-reload")
        os.system("systemctl enable --now lab-agent.service")
        results["status"] = "enabled and started"
    else:
        results["status"] = "written (not enabled)"
    return results
