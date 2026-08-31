"""Per-lab mergerfs union mounts.

One mergerfs mount per LAB per TIER, not one per tier:

    fast1/labs/labA ─┐                    fast1/labs/labB ─┐
                     ├─ /fast/labA                         ├─ /fast/labB
    fast2/labs/labA ─┘                    fast2/labs/labB ─┘

Merging whole ``labs`` roots instead would put every lab's data behind one union, so a single ZFS
quota could no longer be attributed to one lab and one lab's exhausted branch would affect another.
Per-lab mounts keep the quota story intact: each branch of each lab is its own quota'd dataset.

Two safety rules run through everything here:

* **A branch is only ever a genuinely mounted ZFS dataset.** If a pool is missing, its would-be
  branch directory may still exist as an empty directory on the root filesystem; using it would
  silently write lab data onto ``/``. ``active_branches`` filters on live ZFS mount state, never on
  ``os.path.isdir``.
* **Nothing is built by string concatenation into a shell.** Branch paths come from the validated
  tier layout and options come from the allow-listed ``MergerfsOptions``; the mount is executed as
  argv.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass

from ..executors import zfs
from ..executors.base import CommandResult, run
from .model import TierConfig, scaled_minfreespace

MERGERFS_BIN = "mergerfs"
# mergerfs exposes a runtime control file inside every mount. Writing the ``user.mergerfs.branches``
# xattr adds/removes branches on a LIVE mount, so a new disk can join a lab's union without
# unmounting — which means the lab container's bind mount (and its open file handles) survive.
CONTROL_FILE = ".mergerfs"
BRANCHES_XATTR = "user.mergerfs.branches"
# Same control file, for the create-policy threshold that has to track a lab's quota.
MINFREESPACE_XATTR = "user.mergerfs.minfreespace"


class MergerfsError(RuntimeError):
    pass


def available() -> bool:
    return shutil.which(MERGERFS_BIN) is not None


@dataclass(frozen=True)
class BranchProbe:
    """Live state of one candidate branch."""

    pool: str
    dataset: str
    path: str
    mount: zfs.MountState

    @property
    def usable(self) -> bool:
        # ZFS must agree the dataset is mounted at exactly this path AND the kernel must agree the
        # path is a mount point. Either check alone can be fooled by a stale/leftover directory.
        return self.mount.ok and os.path.ismount(self.path)

    def to_dict(self) -> dict:
        return {
            "pool": self.pool,
            "dataset": self.dataset,
            "path": self.path,
            "usable": self.usable,
            "mount": self.mount.to_dict(),
        }


def probe_branches(tier: TierConfig, lab: str, pools: list[str] | None = None) -> list[BranchProbe]:
    """Probe every configured branch of one lab, in configured pool order."""
    return [
        BranchProbe(
            pool=pool,
            dataset=tier.branch_dataset(pool, lab),
            path=tier.branch_mount(pool, lab),
            mount=zfs.mount_state(
                tier.branch_dataset(pool, lab), tier.branch_mount(pool, lab)
            ),
        )
        for pool in (pools if pools is not None else list(tier.pools))
    ]


def active_branches(tier: TierConfig, lab: str, pools: list[str] | None = None) -> list[str]:
    """Paths of the branches safe to hand to mergerfs. Missing/unmounted branches are dropped."""
    return [p.path for p in probe_branches(tier, lab, pools) if p.usable]


# --------------------------------------------------------------------------- command generation


def branch_capacity(path: str) -> int | None:
    """Total bytes a branch can ever hold, which for a quota'd ZFS dataset is its quota."""
    try:
        st = os.statvfs(path)
    except OSError:
        return None
    return st.f_blocks * st.f_frsize


def minfreespace_for(tier: TierConfig, branches: list[str]) -> int:
    """The minfreespace this lab's union should use, scaled to its SMALLEST branch.

    mergerfs measures free space per branch, and a branch's free space is its ZFS quota minus its
    usage — so the tier-wide ceiling has to be scaled down for a lab whose quota is smaller than it.
    The smallest branch decides, because a branch below minfreespace is simply skipped for new
    files, and skipping every branch is ENOSPC.
    """
    capacities = [c for c in (branch_capacity(b) for b in branches) if c]
    ceiling = tier.mergerfs.minfreespace_bytes
    return scaled_minfreespace(ceiling, min(capacities)) if capacities else ceiling


def mount_argv(
    tier: TierConfig, lab: str, branches: list[str], *, minfreespace: int | None = None,
) -> list[str]:
    """The exact argv used to mount one lab's union. Pure, so it is unit-testable without FUSE."""
    if not branches:
        raise MergerfsError(
            f"refusing to mount {tier.logical_mount(lab)}: no backing ZFS branch is mounted"
        )
    return [
        MERGERFS_BIN,
        "-o",
        tier.mergerfs.option_string(
            fsname=tier.fsname(lab),
            minfreespace=minfreespace_for(tier, branches) if minfreespace is None else minfreespace,
        ),
        ":".join(branches),
        tier.logical_mount(lab),
    ]


def is_mergerfs_mount(path: str) -> bool:
    """Whether ``path`` is a mergerfs mount right now (not a plain directory, nor another fs)."""
    if not os.path.ismount(path):
        return False
    res = run(["findmnt", "-n", "-o", "FSTYPE", "--target", path], timeout=15)
    if not res.ok:
        return False
    return res.stdout.strip().splitlines()[-1].strip() == "fuse.mergerfs" if res.stdout.strip() \
        else False


def current_branches(mountpoint: str) -> list[str]:
    """Branches of a live mergerfs mount, read from its runtime control file."""
    res = run(
        ["getfattr", "--only-values", "-n", BRANCHES_XATTR,
         os.path.join(mountpoint, CONTROL_FILE)],
        timeout=20,
    )
    if not res.ok:
        return []
    # mergerfs returns "path=mode:path=mode"; we only care about the paths.
    return [entry.split("=", 1)[0] for entry in res.stdout.strip().split(":") if entry]


def add_branch_live(mountpoint: str, branch: str) -> CommandResult:
    """Append a branch to a RUNNING mergerfs mount via its control file.

    This is what makes "add a drive later" non-disruptive: the mount is not replaced, so the lab
    container's bind mount stays valid and no restart is needed. Falls back to a remount (which does
    need a container restart) only when this fails.
    """
    return run(
        ["setfattr", "-n", BRANCHES_XATTR, "-v", f"+>{branch}",
         os.path.join(mountpoint, CONTROL_FILE)],
        timeout=20,
    )


def set_minfreespace_live(mountpoint: str, value: int) -> CommandResult:
    """Update minfreespace on a RUNNING mergerfs mount.

    The right value depends on the lab's quota, so it has to move when the quota does — otherwise a
    lab shrunk to 64 GiB keeps a 50 GiB threshold and can never create a file, and a lab grown to
    2 TiB keeps a threshold sized for its old quota. Doing it live keeps the container's bind mount
    (and every open file handle) intact.
    """
    return run(
        ["setfattr", "-n", MINFREESPACE_XATTR, "-v", str(int(value)),
         os.path.join(mountpoint, CONTROL_FILE)],
        timeout=20,
    )


def remove_branch_live(mountpoint: str, branch: str) -> CommandResult:
    """Drop a branch from a RUNNING mergerfs mount.

    Needed when a disk goes away: the branch path may still exist as an EMPTY directory on the root
    filesystem, and leaving it in the union would let mergerfs create files there — exactly the
    silent "writes land on /" failure this design must prevent.
    """
    return run(
        ["setfattr", "-n", BRANCHES_XATTR, "-v", f"-{branch}",
         os.path.join(mountpoint, CONTROL_FILE)],
        timeout=20,
    )


# --------------------------------------------------------------------------- mount lifecycle


def ensure_mountpoint(path: str) -> None:
    """Create the logical mountpoint directory, refusing to reuse a symlink."""
    if os.path.islink(path):
        raise MergerfsError(f"refusing to mount over the symlink '{path}'")
    os.makedirs(path, exist_ok=True)


def mount(tier: TierConfig, lab: str, branches: list[str]) -> str:
    """Mount one lab's union. Idempotent: an existing correct mount is left alone."""
    if not available():
        raise MergerfsError(
            "mergerfs is not installed; run `lab-agent host-prepare` (it installs mergerfs for any "
            "tier configured with the mergerfs backend)"
        )
    target = tier.logical_mount(lab)
    ensure_mountpoint(target)
    if is_mergerfs_mount(target):
        return target
    if os.path.ismount(target):
        raise MergerfsError(
            f"'{target}' is already a mount but is not mergerfs; unmount it before continuing"
        )
    res = run(mount_argv(tier, lab, branches), timeout=60)
    if not res.ok:
        raise MergerfsError(res.logs)
    return target


def unmount(path: str) -> None:
    """Unmount a mergerfs mount if present (lazily, so a busy mount still detaches)."""
    if not os.path.ismount(path):
        return
    res = run(["umount", path], timeout=60)
    if res.ok:
        return
    lazy = run(["umount", "-l", path], timeout=60)
    if not lazy.ok:
        raise MergerfsError(lazy.logs)


def remount(tier: TierConfig, lab: str, branches: list[str]) -> str:
    """Replace a lab's union with one over ``branches``. Disruptive to open file handles."""
    unmount(tier.logical_mount(lab))
    return mount(tier, lab, branches)


@dataclass
class BranchAttachResult:
    mountpoint: str
    added_live: bool
    remounted: bool
    detail: str


def attach_branch(
    tier: TierConfig, lab: str, branch: str, branches: list[str]
) -> BranchAttachResult:
    """Add one branch to a lab's union, preferring the non-disruptive live path.

    ``branches`` is the full desired branch list, used for the remount fallback and when the mount
    does not exist yet.
    """
    target = tier.logical_mount(lab)
    if not is_mergerfs_mount(target):
        mount(tier, lab, branches)
        return BranchAttachResult(
            target, False, False, f"mounted {target} with {len(branches)} branch(es)"
        )
    if branch in current_branches(target):
        return BranchAttachResult(
            target, False, False, f"{branch} already attached to {target}"
        )
    res = add_branch_live(target, branch)
    if res.ok:
        return BranchAttachResult(
            target, True, False, f"attached {branch} to the live mount {target}"
        )
    remount(tier, lab, branches)
    detail = res.logs.strip().splitlines()[-1] if res.logs.strip() else "no detail"
    return BranchAttachResult(
        target, False, True,
        f"live attach of {branch} failed ({detail}); remounted {target} — the lab container "
        "must be restarted to see it",
    )
