"""lab-agent command-line entrypoint."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .config import DEFAULT_CONFIG_PATH, AgentConfig, load_config
from .system import detect_capabilities


def _cmd_run(args: argparse.Namespace) -> int:
    from .client import run_agent

    cfg = load_config(Path(args.config) if args.config else None)
    run_agent(cfg)
    return 0


def _cmd_install(args: argparse.Namespace) -> int:
    from .installer import install

    cfg = AgentConfig(controller_url=args.controller, token=args.token or "")
    if args.node_name:
        cfg.node_name = args.node_name
    if args.fast_pool:
        cfg.fast_pool = args.fast_pool
    if args.slow_pool:
        cfg.slow_pool = args.slow_pool
    if args.slow_backend:
        cfg.slow_backend = args.slow_backend
    if args.slow_path:
        cfg.slow_path = args.slow_path
    if args.slow_shared:
        cfg.slow_shared = True
    if args.no_verify_tls:
        cfg.tls_verify = False
    config_path = Path(args.config) if args.config else DEFAULT_CONFIG_PATH
    result = install(cfg, config_path, enable=not args.no_enable)
    for key, value in result.items():
        print(f"{key}: {value}")
    if not cfg.token:
        print(
            "note: no token set yet. Provision this node in the controller UI (Nodes -> "
            "Provision token), then run: sudo lab-agent set-token <TOKEN>"
        )
    return 0


def _cmd_set_token(args: argparse.Namespace) -> int:
    """Write a controller-issued per-node token into the existing config and restart the service."""
    import os

    from .config import save_config

    config_path = Path(args.config) if args.config else DEFAULT_CONFIG_PATH
    cfg = load_config(config_path)
    cfg.token = args.token
    saved = save_config(cfg, config_path)
    print(f"token written: {saved}")
    if args.no_restart:
        print("restart skipped; run `systemctl restart lab-agent` to apply.")
        return 0
    rc = os.system("systemctl restart lab-agent.service")
    print("restarted lab-agent.service" if rc == 0 else
          "could not restart automatically; run `systemctl restart lab-agent` manually.")
    return 0


def _cmd_doctor(args: argparse.Namespace) -> int:
    # Doctor works even before install: synthesize a minimal config if none exists.
    try:
        cfg = load_config(Path(args.config) if args.config else None)
    except FileNotFoundError:
        cfg = AgentConfig(controller_url="(none)", token="(none)")
    from . import maintenance_state

    caps = detect_capabilities(cfg)
    print(f"node: {cfg.node_name}")
    for field, value in caps.to_dict().items():
        if field == "issues":
            continue
        print(f"  {field}: {value}")
    # Persistent weekly-patch bookkeeping: when each lab's container was last apt-upgraded.
    patched = maintenance_state.all_apt_upgrades(cfg)
    if patched:
        print("last apt upgrade (epoch ms):")
        for lab, ts in sorted(patched.items()):
            print(f"  {lab}: {ts}")
    if caps.issues:
        print("issues:")
        for issue in caps.issues:
            print(f"  - {issue}")
        return 1
    print("all checks passed")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lab-agent", description="Lab manager node agent")
    parser.add_argument("--version", action="version", version=f"lab-agent {__version__}")
    parser.add_argument("--config", help=f"config path (default: {DEFAULT_CONFIG_PATH})")
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="run the agent in the foreground")
    p_run.set_defaults(func=_cmd_run)

    p_install = sub.add_parser("install", help="write config + systemd unit")
    p_install.add_argument("--controller", required=True, help="controller URL, e.g. wss://host:port")
    p_install.add_argument("--token", help="per-node token from the controller UI (or set it later "
                                          "with `lab-agent set-token`)")
    p_install.add_argument("--node-name", help="override node name (default: hostname)")
    p_install.add_argument("--fast-pool", help="fast ZFS pool name (default: fast)")
    p_install.add_argument("--slow-pool", help="slow ZFS pool name (default: slow)")
    p_install.add_argument("--slow-backend", choices=["zfs", "smb"],
                           help="cold-storage backend (default: zfs)")
    p_install.add_argument("--slow-path",
                           help="cold-storage mount path for smb backend (default: /mnt/cold)")
    p_install.add_argument("--slow-shared", action="store_true",
                           help="cold-storage SMB share is mounted on more than one node")
    p_install.add_argument("--no-verify-tls", action="store_true",
                           help="skip TLS verification (self-signed controller)")
    p_install.add_argument("--no-enable", action="store_true",
                           help="write files but do not enable/start the service")
    p_install.set_defaults(func=_cmd_install)

    p_set_token = sub.add_parser("set-token", help="write a controller-issued token and restart")
    p_set_token.add_argument("token", help="the per-node token shown in the controller UI")
    p_set_token.add_argument("--no-restart", action="store_true",
                             help="write the token but do not restart the service")
    p_set_token.set_defaults(func=_cmd_set_token)

    p_doctor = sub.add_parser("doctor", help="check zfs/docker/nvidia/pools")
    p_doctor.set_defaults(func=_cmd_doctor)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
