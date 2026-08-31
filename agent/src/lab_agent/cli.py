"""lab-agent command-line entrypoint."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

from . import __version__
from .config import DEFAULT_CONFIG_PATH, AgentConfig, load_config
from .storage.model import (
    BACKEND_MERGERFS,
    BACKEND_SMB,
    BACKEND_ZFS,
    DEFAULT_COLD_MOUNT_ROOT,
    DEFAULT_COLD_POOL,
    DEFAULT_FAST_POOL,
    StorageConfig,
    StorageConfigError,
    legacy_storage,
)
from .system import detect_capabilities


def _storage_from_flags(args: argparse.Namespace) -> StorageConfig:
    """Build a StorageConfig from the install flags.

    One pool per tier keeps the plain ``zfs`` backend (no FUSE on a single-disk node). Two or more
    switches that tier to ``mergerfs``, which is also what a later ``storage add-pool`` does — so a
    node bootstrapped with one disk expands without being rebuilt.
    """
    fast_pools = args.fast_pool or [DEFAULT_FAST_POOL]
    cold_pools = args.cold_pool or args.slow_pool or [DEFAULT_COLD_POOL]
    cold_backend = args.cold_backend or args.slow_backend or (
        BACKEND_MERGERFS if len(cold_pools) > 1 else BACKEND_ZFS
    )
    storage = legacy_storage(
        fast_pool=fast_pools[0],
        slow_pool=cold_pools[0],
        slow_backend=BACKEND_SMB if cold_backend == BACKEND_SMB else BACKEND_ZFS,
        slow_path=args.slow_path or DEFAULT_COLD_MOUNT_ROOT,
        docker_pool=args.docker_pool,
    )
    fast = storage.fast.with_pools(tuple(fast_pools))
    storage = storage.with_tier(fast)
    if cold_backend != BACKEND_SMB:
        if cold_backend == BACKEND_ZFS and len(cold_pools) > 1:
            raise StorageConfigError(
                "--cold-backend zfs supports one pool; use mergerfs for multiple pools"
            )
        cold = storage.cold.with_pools(tuple(cold_pools))
        if cold_backend == BACKEND_MERGERFS:
            cold = replace(cold, backend=BACKEND_MERGERFS).validate()
        storage = storage.with_tier(cold)
    return storage.validate()


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
    # Storage flags seed the TEMPLATE's [storage.*] tables. Several --fast-pool/--cold-pool flags
    # select the mergerfs backend for that tier automatically; one keeps the plain ZFS backend.
    try:
        cfg.storage = _storage_from_flags(args)
    except StorageConfigError as exc:
        print(f"install failed: {exc}", file=sys.stderr)
        return 1
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
    print("       set controller_url, token, node_name, and the [storage.*] tier settings")
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
    p_install.add_argument("--fast-pool", action="append",
                           help="fast ZFS pool (repeat for several; 2+ selects mergerfs)")
    p_install.add_argument("--cold-pool", action="append",
                           help="cold ZFS pool (repeat for several; 2+ selects mergerfs)")
    p_install.add_argument("--slow-pool", action="append",
                           help=argparse.SUPPRESS)  # legacy alias for --cold-pool
    p_install.add_argument("--cold-backend", choices=["zfs", "mergerfs", "smb"],
                           help="cold-storage backend (default: zfs, or mergerfs for 2+ pools)")
    p_install.add_argument("--slow-backend", choices=["zfs", "mergerfs", "smb"],
                           help=argparse.SUPPRESS)  # legacy alias for --cold-backend
    p_install.add_argument(
        "--docker-pool",
        help="ZFS pool backing Docker's data-root (default: the first fast pool)")
    p_install.add_argument("--slow-path",
                           help="cold-storage mount path for smb backend (default: /cold-storage)")
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
        "host-prepare", help="configure Docker, storage, host limits, and NVIDIA CDI"
    )
    p_prepare.set_defaults(func=_cmd_host_prepare)

    _add_storage_parser(sub)

    return parser


def _add_storage_parser(sub: argparse._SubParsersAction) -> None:
    """`lab-agent storage ...` — the local half of what the controller's Storage UI does.

    Everything here also works with the controller offline, which is the point: a node must be able
    to bring its own storage up and be inspected without one.
    """
    p_storage = sub.add_parser("storage", help="inspect and manage this node's storage tiers")
    ops = p_storage.add_subparsers(dest="storage_command", required=True)

    p_status = ops.add_parser("status", help="tiers, pools, devices and per-lab branch quotas")
    p_status.add_argument("--json", action="store_true", help="print the raw inventory as JSON")
    p_status.set_defaults(func=_cmd_storage_status)

    p_mount = ops.add_parser(
        "mount", help="converge ZFS tier roots + per-lab mergerfs mounts (idempotent)"
    )
    p_mount.set_defaults(func=_cmd_storage_mount)

    p_umount = ops.add_parser("unmount", help="unmount every per-lab mergerfs union")
    p_umount.set_defaults(func=_cmd_storage_unmount)

    p_devices = ops.add_parser("devices", help="list physical disks with stable by-id identity")
    p_devices.set_defaults(func=_cmd_storage_devices)

    p_add = ops.add_parser(
        "add-pool", help="attach an EXISTING ZFS pool to a tier and extend every lab onto it"
    )
    p_add.add_argument("--tier", required=True, choices=["fast", "cold"])
    p_add.add_argument("--pool", required=True, help="an existing ZFS pool on this node")
    p_add.set_defaults(func=_cmd_storage_add_pool)

    p_remove = ops.add_parser(
        "remove-pool",
        help="detach a pool from a tier (admin decision; destroys no dataset)",
    )
    p_remove.add_argument("--tier", required=True, choices=["fast", "cold"])
    p_remove.add_argument("--pool", required=True, help="a pool currently backing that tier")
    p_remove.add_argument(
        "--confirm", action="store_true",
        help="accept that any files still on the pool leave the logical tier",
    )
    p_remove.set_defaults(func=_cmd_storage_remove_pool)

    p_rebalance = ops.add_parser(
        "rebalance", help="reshard branch quotas across pools (moves quota, never files)"
    )
    p_rebalance.add_argument("--tier", choices=["fast", "cold"], help="default: both tiers")
    p_rebalance.add_argument(
        "--min-delta-gb", type=float, default=0.0,
        help="skip a lab whose branch quotas would all move by less than this (default: 0, "
             "meaning re-slice exactly). The controller's scheduled rebalance sends its own value.",
    )
    p_rebalance.set_defaults(func=_cmd_storage_rebalance)


def _storage_cfg(args: argparse.Namespace) -> AgentConfig:
    try:
        return load_config(Path(args.config) if args.config else None)
    except FileNotFoundError:
        return AgentConfig(controller_url="", token="")


def _run_storage_op(args: argparse.Namespace, handler, params: dict) -> int:
    import json as _json

    cfg = _storage_cfg(args)
    try:
        result, note = handler(cfg, params)
    except Exception as exc:
        print(f"storage operation failed: {exc}", file=sys.stderr)
        return 1
    if getattr(args, "json", False):
        print(_json.dumps(result, indent=2, sort_keys=True))
    print(note)
    return 0


def _cmd_storage_status(args: argparse.Namespace) -> int:
    from . import storageops

    cfg = _storage_cfg(args)
    try:
        report, note = storageops.status(cfg, {})
    except Exception as exc:
        print(f"storage status failed: {exc}", file=sys.stderr)
        return 1
    if args.json:
        import json as _json

        print(_json.dumps(report, indent=2, sort_keys=True))
        return 0
    for name, tier in sorted(report["tiers"].items()):
        print(f"{name}: backend={tier['backend']} health={tier['health']} "
              f"path={tier['mount_root']}")
        for pool in tier["pools"]:
            flag = "ok" if pool["usable"] else "UNUSABLE"
            print(f"  - {pool['pool']}: {pool['health']} ({flag}) "
                  f"free={pool['free_bytes']} of {pool['size_bytes']}")
        if not tier["pools"]:
            print("  - (no local pools)")
    docker = report["docker"]
    print(f"docker: pool={docker['pool']} dataset={docker['dataset']} "
          f"native_zfs={docker['on_zfs']} data_root={docker['data_root']}")
    print(note)
    return 0


def _cmd_storage_mount(args: argparse.Namespace) -> int:
    from . import storageops

    return _run_storage_op(args, storageops.mount, {})


def _cmd_storage_unmount(args: argparse.Namespace) -> int:
    from .storage import mergerfs as mfs
    from .storage import service

    cfg = _storage_cfg(args)
    count = 0
    for tier in cfg.storage.tiers():
        if not tier.uses_mergerfs:
            continue
        for lab in service.discover_labs(tier):
            try:
                mfs.unmount(tier.logical_mount(lab))
                count += 1
            except mfs.MergerfsError as exc:
                print(f"could not unmount {tier.logical_mount(lab)}: {exc}", file=sys.stderr)
    print(f"unmounted {count} union mount(s)")
    return 0


def _cmd_storage_devices(args: argparse.Namespace) -> int:
    from . import storageops

    cfg = _storage_cfg(args)
    result, _note = storageops.list_devices(cfg, {})
    for device in result["devices"]:
        used = device["zfs_pool"] or (", ".join(device["filesystems"]) or "free")
        print(f"{device['by_id'] or device['name']}  {device['size_bytes']} bytes  "
              f"{device['type']}  {device['model'] or '?'}  [{used}]")
    return 0


def _cmd_storage_add_pool(args: argparse.Namespace) -> int:
    from . import storageops

    return _run_storage_op(
        args, storageops.attach_pool, {"tier": args.tier, "pool": args.pool}
    )


def _cmd_storage_remove_pool(args: argparse.Namespace) -> int:
    from . import storageops

    return _run_storage_op(
        args, storageops.remove_pool,
        {"tier": args.tier, "pool": args.pool, "confirm": bool(args.confirm)},
    )


def _cmd_storage_rebalance(args: argparse.Namespace) -> int:
    from . import storageops

    params: dict = {"tier": args.tier} if args.tier else {}
    if args.min_delta_gb:
        params["min_delta_bytes"] = int(args.min_delta_gb * 1024 ** 3)
    return _run_storage_op(args, storageops.rebalance, params)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except PermissionError as exc:
        # Most subcommands manage /etc, /var/lib, systemd or the docker socket, and the config is
        # root-only. Since the agent installs onto every user's PATH, an unprivileged invocation is
        # routine: report it as one actionable line instead of a traceback.
        print(f"lab-agent: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
