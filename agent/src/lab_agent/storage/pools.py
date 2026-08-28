"""Physical device + ZFS pool inventory, and safe pool creation.

The controller WebUI needs to show an admin what disks a node actually has before offering to
initialize one as a new pool, so this reports stable identity (``/dev/disk/by-id/...``, model,
serial) rather than ``/dev/sdX``, which is not persistent across reboots.

Creating a pool DESTROYS the selected disks, so every input crossing the wire is re-validated here:

* device paths must live under ``/dev/disk/by-id`` (or ``by-path``), contain no traversal, and
  resolve to a real block device that ``lsblk`` reports as a whole disk;
* a device that already holds a filesystem, a partition table, or a ZFS label is refused unless the
  caller explicitly passes ``force``;
* the vdev type is an allow-listed constant, never a wire string spliced into argv.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from typing import Any

from ..executors import zfs
from ..executors.base import run
from .model import StorageConfigError, validate_pool_name

# Only persistent-identity symlink directories. /dev/sdX is explicitly NOT accepted.
DEVICE_ROOTS = ("/dev/disk/by-id/", "/dev/disk/by-path/")
DEVICE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$")
VDEV_TYPES = ("", "mirror", "raidz1", "raidz2", "raidz3")


def validate_device(path: Any) -> str:
    """Validate a caller-supplied device path down to a real whole-disk block device."""
    if not isinstance(path, str):
        raise StorageConfigError("device must be a string")
    root = next((r for r in DEVICE_ROOTS if path.startswith(r)), None)
    if root is None:
        raise StorageConfigError(
            f"device must be a stable /dev/disk/by-id (or by-path) path, got {path!r}"
        )
    name = path[len(root):]
    if not DEVICE_NAME_RE.match(name) or "/" in name:
        raise StorageConfigError(f"invalid device identifier {name!r}")
    if os.path.normpath(path) != path:
        raise StorageConfigError(f"device path must be normalized, got {path!r}")
    return path


def validate_vdev_type(value: Any) -> str:
    if value in (None, ""):
        return ""
    if value not in VDEV_TYPES:
        raise StorageConfigError(
            f"vdev type must be one of {', '.join(t or 'single' for t in VDEV_TYPES)}"
        )
    return value


# --------------------------------------------------------------------------- device inventory


@dataclass
class BlockDevice:
    """One whole disk, as the WebUI should show it."""

    name: str  # kernel name, e.g. "sda" — display only, never used as identity
    by_id: str | None  # the stable path we actually operate on
    model: str | None
    serial: str | None
    size_bytes: int
    rotational: bool
    transport: str | None
    mounted: bool
    in_use: bool  # holds a filesystem, partition table or ZFS label
    filesystems: list[str] = field(default_factory=list)
    zfs_pool: str | None = None  # the pool it already belongs to, if any
    partitions: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "by_id": self.by_id,
            "model": self.model,
            "serial": self.serial,
            "size_bytes": self.size_bytes,
            "rotational": self.rotational,
            "type": "hdd" if self.rotational else "ssd",
            "transport": self.transport,
            "mounted": self.mounted,
            "in_use": self.in_use,
            "filesystems": list(self.filesystems),
            "zfs_pool": self.zfs_pool,
            "partitions": self.partitions,
        }


def _by_id_map() -> dict[str, str]:
    """kernel name -> preferred /dev/disk/by-id path (a readable model-serial link beats a wwn)."""
    out: dict[str, str] = {}
    root = "/dev/disk/by-id"
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return out
    for entry in entries:
        link = os.path.join(root, entry)
        try:
            target = os.path.basename(os.path.realpath(link))
        except OSError:
            continue
        if not DEVICE_NAME_RE.match(entry):
            continue
        current = out.get(target)
        # Prefer a descriptive ata-/nvme-/scsi- name over a bare wwn-, and never a partition link.
        if entry.startswith(("wwn-", "lvm-", "dm-")) and current:
            continue
        if current and not current.split("/")[-1].startswith(("wwn-", "lvm-", "dm-")):
            continue
        out[target] = link
    return out


def _zfs_member_pools() -> dict[str, str]:
    """kernel device name -> pool name, for disks already claimed by ZFS."""
    out: dict[str, str] = {}
    res = run(["lsblk", "-J", "-o", "NAME,FSTYPE,LABEL", "-p"], timeout=30)
    if not res.ok:
        return out
    try:
        tree = json.loads(res.stdout or "{}")
    except json.JSONDecodeError:
        return out

    def walk(node: dict[str, Any], disk: str | None) -> None:
        name = os.path.basename(str(node.get("name", "")))
        top = disk or name
        if node.get("fstype") == "zfs_member" and node.get("label"):
            out[top] = str(node["label"])
        for child in node.get("children", []) or []:
            walk(child, top)

    for node in tree.get("blockdevices", []) or []:
        walk(node, None)
    return out


def list_block_devices() -> list[BlockDevice]:
    """Whole disks on this host with stable identity and current usage."""
    res = run(
        ["lsblk", "-J", "-b", "-d", "-o",
         "NAME,SIZE,ROTA,MODEL,SERIAL,TRAN,TYPE,MOUNTPOINT,FSTYPE"],
        timeout=30,
    )
    if not res.ok:
        return []
    try:
        tree = json.loads(res.stdout or "{}")
    except json.JSONDecodeError:
        return []
    by_id = _by_id_map()
    members = _zfs_member_pools()
    detail = _device_detail()
    out: list[BlockDevice] = []
    for node in tree.get("blockdevices", []) or []:
        if node.get("type") != "disk":
            continue
        name = str(node.get("name", ""))
        info = detail.get(name, {})
        filesystems = [fs for fs in info.get("filesystems", []) if fs]
        partitions = int(info.get("partitions", 0))
        pool = members.get(name)
        out.append(
            BlockDevice(
                name=name,
                by_id=by_id.get(name),
                model=(node.get("model") or None),
                serial=(node.get("serial") or None),
                size_bytes=int(node.get("size") or 0),
                rotational=bool(node.get("rota")),
                transport=(node.get("tran") or None),
                mounted=bool(info.get("mounted")),
                in_use=bool(filesystems or partitions or pool or info.get("mounted")),
                filesystems=filesystems,
                zfs_pool=pool,
                partitions=partitions,
            )
        )
    out.sort(key=lambda d: d.name)
    return out


def _device_detail() -> dict[str, dict[str, Any]]:
    """Per-disk filesystem/partition/mount facts, folded up from the full lsblk tree."""
    res = run(["lsblk", "-J", "-o", "NAME,FSTYPE,MOUNTPOINT,TYPE"], timeout=30)
    if not res.ok:
        return {}
    try:
        tree = json.loads(res.stdout or "{}")
    except json.JSONDecodeError:
        return {}
    out: dict[str, dict[str, Any]] = {}

    def walk(node: dict[str, Any], disk: str) -> None:
        entry = out.setdefault(disk, {"filesystems": [], "partitions": 0, "mounted": False})
        if node.get("fstype"):
            entry["filesystems"].append(str(node["fstype"]))
        if node.get("mountpoint"):
            entry["mounted"] = True
        if node.get("type") == "part":
            entry["partitions"] += 1
        for child in node.get("children", []) or []:
            walk(child, disk)

    for node in tree.get("blockdevices", []) or []:
        if node.get("type") != "disk":
            continue
        walk(node, str(node.get("name", "")))
    return out


# --------------------------------------------------------------------------- pool inventory


@dataclass
class PoolInfo:
    name: str
    guid: str | None
    size_bytes: int
    alloc_bytes: int
    free_bytes: int
    health: str
    imported: bool
    tiers: list[str] = field(default_factory=list)
    devices: list[str] = field(default_factory=list)
    scrub: dict[str, Any] | None = None

    @property
    def healthy(self) -> bool:
        return self.imported and self.health.upper() == "ONLINE"

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "guid": self.guid,
            "size_bytes": self.size_bytes,
            "alloc_bytes": self.alloc_bytes,
            "free_bytes": self.free_bytes,
            "health": self.health,
            "imported": self.imported,
            "healthy": self.healthy,
            "tiers": list(self.tiers),
            "devices": list(self.devices),
            "scrub": self.scrub,
        }


def pool_devices(pool: str) -> list[str]:
    """Leaf vdev names of a pool, for the WebUI's 'which disk is this' column."""
    res = run(["zpool", "list", "-vHP", "-o", "name", pool], timeout=30)
    if not res.ok:
        return []
    out: list[str] = []
    for line in res.stdout.splitlines()[1:]:
        token = line.strip().split("\t")[0].strip() if "\t" in line else line.strip().split()[0:1]
        token = token if isinstance(token, str) else (token[0] if token else "")
        if token.startswith("/dev/"):
            out.append(token)
    return out


def inspect_pool(pool: str, *, tiers: list[str] | None = None,
                 with_scrub: bool = True) -> PoolInfo:
    capacity = zfs.pool_capacity(pool)
    if capacity is None:
        return PoolInfo(pool, None, 0, 0, 0, "UNAVAIL", False, tiers or [], [], None)
    scrub = zfs.scrub_status(pool).to_dict() if with_scrub else None
    return PoolInfo(
        name=pool,
        guid=zfs.pool_guid(pool),
        size_bytes=capacity.size,
        alloc_bytes=capacity.alloc,
        free_bytes=capacity.free,
        health=capacity.health,
        imported=True,
        tiers=tiers or [],
        devices=pool_devices(pool),
        scrub=scrub,
    )


# --------------------------------------------------------------------------- pool creation


def create_pool(
    pool: str,
    devices: list[Any],
    *,
    vdev_type: str = "",
    force: bool = False,
) -> dict[str, Any]:
    """Initialize a NEW ZFS pool on the given disks. DESTROYS everything on them.

    Refuses to touch a disk that is already in use unless ``force`` is set, and never proceeds when
    the pool name already exists.
    """
    validate_pool_name(pool)
    vdev = validate_vdev_type(vdev_type)
    if not isinstance(devices, list) or not devices:
        raise StorageConfigError("at least one device is required")
    paths = [validate_device(d) for d in devices]
    if len(set(paths)) != len(paths):
        raise StorageConfigError("the same device was listed more than once")
    if zfs.pool_exists(pool):
        raise StorageConfigError(f"a ZFS pool named '{pool}' already exists on this node")
    if vdev.startswith("raidz") and len(paths) < 3:
        raise StorageConfigError(f"{vdev} needs at least 3 devices")
    if vdev == "mirror" and len(paths) < 2:
        raise StorageConfigError("mirror needs at least 2 devices")

    inventory = {d.by_id: d for d in list_block_devices() if d.by_id}
    for path in paths:
        real = os.path.realpath(path)
        device = inventory.get(path)
        if device is None:
            raise StorageConfigError(
                f"'{path}' is not a whole disk on this node (resolved to {real})"
            )
        if device.in_use and not force:
            detail = device.zfs_pool or ", ".join(device.filesystems) or "existing partitions"
            raise StorageConfigError(
                f"refusing to wipe '{path}': it is already in use ({detail}). "
                "Confirm the destructive action explicitly to proceed."
            )
    zfs.create_pool(pool, paths, vdev_type=vdev, force=force)
    return {"pool": pool, "devices": paths, "vdev_type": vdev or "single"}
