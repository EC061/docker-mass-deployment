"""lab-agent command-line entrypoint."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from . import __version__
from .config import DEFAULT_CONFIG_PATH, AgentConfig, load_config
from .system import detect_capabilities


def _config_path(args: argparse.Namespace) -> Path:
    return Path(args.config) if args.config else DEFAULT_CONFIG_PATH


def _cmd_run(args: argparse.Namespace) -> int:
    from .client import run_agent

    cfg = load_config(Path(args.config) if args.config else None)
    run_agent(cfg)
    return 0


def _cmd_install(args: argparse.Namespace) -> int:
    from .installer import install

    # Flags only seed a freshly-written config TEMPLATE; an existing config is preserved untouched.
    cfg = AgentConfig(controller_url=args.controller or "", token=args.token or "")
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
    if args.no_verify_tls:
        cfg.tls_verify = False
    config_path = _config_path(args)
    try:
        result = install(cfg, config_path, enable=not args.no_enable, ref=args.ref)
    except (PermissionError, RuntimeError) as exc:
        print(f"install failed: {exc}", file=sys.stderr)
        return 1
    for key, value in result.items():
        print(f"{key}: {value}")
    # The service is installed + enabled but NOT started: the operator edits the config first.
    print("\nNext steps:")
    print(f"  1. Edit the config:   sudo lab-agent edit-config   (or edit {config_path})")
    print("       set controller_url, token, node_name, and the cold-storage (slow_*) settings")
    print("  2. Start the agent:   sudo lab-agent start")
    print("  3. Verify health:     sudo lab-agent doctor")
    return 0


def _cmd_start(args: argparse.Namespace) -> int:
    from .installer import start_service

    try:
        start_service()
    except (PermissionError, RuntimeError) as exc:
        print(f"start failed: {exc}", file=sys.stderr)
        return 1
    print("lab-agent.service started (and enabled on boot). Run `lab-agent doctor` to verify.")
    return 0


def _cmd_stop(args: argparse.Namespace) -> int:
    from .installer import stop_service

    try:
        stop_service()
    except PermissionError as exc:
        print(f"stop failed: {exc}", file=sys.stderr)
        return 1
    print("lab-agent.service stopped.")
    return 0


def _cmd_upgrade(args: argparse.Namespace) -> int:
    from .installer import upgrade

    try:
        result = upgrade(ref=args.ref)
    except (PermissionError, RuntimeError) as exc:
        print(f"upgrade failed: {exc}", file=sys.stderr)
        return 1
    for key, value in result.items():
        print(f"{key}: {value}")
    print("lab-agent upgraded and restarted.")
    return 0


def _cmd_edit_config(args: argparse.Namespace) -> int:
    config_path = _config_path(args)
    if not config_path.exists():
        print(f"no config at {config_path}; run `lab-agent install` first.", file=sys.stderr)
        return 1
    import shutil

    editor = (
        os.environ.get("EDITOR")
        or os.environ.get("VISUAL")
        or shutil.which("nano")
        or shutil.which("vi")
    )
    if not editor:
        print(f"no editor found (set $EDITOR); edit {config_path} manually.", file=sys.stderr)
        return 1
    return subprocess.call([editor, str(config_path)])


def _cmd_set_token(args: argparse.Namespace) -> int:
    """Write a controller-issued per-node token into the existing config and restart the service."""
    from .config import save_config

    config_path = _config_path(args)
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
    from .installer import service_status

    caps = detect_capabilities(cfg, deep=True)
    print(f"node: {cfg.node_name}")
    # Service state (best-effort; works before/after install).
    status = service_status()
    print(f"  service: {status['active']} ({status['enabled']})")
    for field, value in caps.to_dict().items():
        print(f"  {field}: {value}")
    # Persistent weekly-patch bookkeeping: when each lab's container was last apt-upgraded.
    patched = maintenance_state.all_apt_upgrades(cfg)
    if patched:
        print("last apt upgrade (epoch ms):")
        for lab, ts in sorted(patched.items()):
            print(f"  {lab}: {ts}")
    if caps.health.issues:
        print("issues:")
        for issue in caps.health.issues:
            print(f"  - [{issue.severity}] {issue.code}: {issue.message}")
        return 1
    print("all checks passed")
    return 0


def _cmd_host_prepare(args: argparse.Namespace) -> int:
    from .hostprep import prepare_host

    try:
        cfg = load_config(Path(args.config) if args.config else None)
    except FileNotFoundError:
        cfg = AgentConfig(controller_url="", token="")
    try:
        result = prepare_host(cfg)
    except (PermissionError, RuntimeError, ValueError) as exc:
        print(f"host preparation failed: {exc}", file=sys.stderr)
        return 1
    for key, value in result.items():
        print(f"{key}: {value}")
    print("host preparation complete; run `lab-agent doctor` with a provisioned lab")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lab-agent", description="Lab manager node agent")
    parser.add_argument("--version", action="version", version=f"lab-agent {__version__}")
    parser.add_argument("--config", help=f"config path (default: {DEFAULT_CONFIG_PATH})")
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="run the agent in the foreground")
    p_run.set_defaults(func=_cmd_run)

    p_install = sub.add_parser(
        "install", help="install the agent + systemd unit (enabled, not started)"
    )
    p_install.add_argument("--controller", help="controller URL, e.g. wss://host:port "
                                                "(optional; can be set in the config afterward)")
    p_install.add_argument("--token", help="per-node token from the controller UI (optional; set "
                                          "later via the config or `lab-agent set-token`)")
    p_install.add_argument("--node-name", help="override node name (default: hostname)")
    p_install.add_argument("--fast-pool", help="fast ZFS pool name (default: fast)")
    p_install.add_argument("--slow-pool", help="slow ZFS pool name (default: slow)")
    p_install.add_argument("--slow-backend", choices=["zfs", "smb"],
                           help="cold-storage backend (default: zfs)")
    p_install.add_argument("--slow-path",
                           help="cold-storage mount path for smb backend (default: /mnt/cold)")
    p_install.add_argument("--no-verify-tls", action="store_true",
                           help="skip TLS verification (self-signed controller)")
    p_install.add_argument("--no-enable", action="store_true",
                           help="write files but do not enable the service")
    p_install.add_argument("--ref", help="pin the install to a git tag/commit (default: newest)")
    p_install.set_defaults(func=_cmd_install)

    p_start = sub.add_parser("start", help="enable + start the service")
    p_start.set_defaults(func=_cmd_start)

    p_stop = sub.add_parser("stop", help="stop the service")
    p_stop.set_defaults(func=_cmd_stop)

    p_upgrade = sub.add_parser("upgrade", help="reinstall the newest agent and restart")
    p_upgrade.add_argument("--ref", help="pin the upgrade to a git tag/commit (default: newest)")
    p_upgrade.set_defaults(func=_cmd_upgrade)

    p_edit = sub.add_parser("edit-config", help="open the config file in $EDITOR")
    p_edit.set_defaults(func=_cmd_edit_config)

    p_set_token = sub.add_parser("set-token", help="write a controller-issued token and restart")
    p_set_token.add_argument("token", help="the per-node token shown in the controller UI")
    p_set_token.add_argument("--no-restart", action="store_true",
                             help="write the token but do not restart the service")
    p_set_token.set_defaults(func=_cmd_set_token)

    p_doctor = sub.add_parser("doctor", help="check service + zfs/docker/nvidia/pools")
    p_doctor.set_defaults(func=_cmd_doctor)

    p_prepare = sub.add_parser(
        "host-prepare", help="configure Docker userns, sysctls, AppArmor, seccomp, and CDI"
    )
    p_prepare.set_defaults(func=_cmd_host_prepare)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
