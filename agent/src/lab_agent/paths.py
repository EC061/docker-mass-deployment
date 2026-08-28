"""Lab name validation and the container-facing storage paths.

Each lab has one quota-bearing dataset **per pool per tier**, and one stable logical path per tier
that a container ever sees. Student storage remains a directory below that root unless an optional
placement-wide student quota is enabled; only then is that student's path a direct child dataset.
There are no ``shared`` or ``users`` intermediate datasets.

    <pool>/labs/<lab>[/<user>]  ->  /fast/<lab>[/<user>]          ->  /home[/<user>]
    <pool>/labs/<lab>[/<user>]  ->  /cold-storage/<lab>[/<user>]
    /home/<user> is the student's persistent fast directory
    /home/<user>/cold-storage -> /cold-storage/<user>

With one pool per tier the dataset mounts directly at the logical path (the original layout). With
several, the datasets mount out of sight under ``/mnt/lab-storage/<pool>/labs/<lab>`` and a per-lab
mergerfs union provides the same logical path. Nothing above this layer — containers, students,
SMB clients — can tell the difference.

The dataset layout itself lives in ``storage.model.TierConfig``; this module is the thin
lab-name-validating façade the rest of the agent uses.
"""

from __future__ import annotations

import re

from .config import AgentConfig
from .storage.model import TIER_COLD, TIER_FAST

# Defense-in-depth: the controller already allow-lists lab names (lib/labs.ts), but the agent runs
# as root, so it re-validates before a name is ever interpolated into a dataset/container argument
# (M-04). Same shape as the controller's LAB_NAME_RE.
LAB_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$")


def validate_lab_name(lab: str) -> str:
    if not LAB_NAME_RE.match(lab):
        raise ValueError(f"invalid lab name '{lab}'")
    return lab


def fast_mount(cfg: AgentConfig, lab: str) -> str:
    """The lab's logical fast path (``/fast/<lab>``), whatever backs it."""
    return cfg.storage.fast.logical_mount(validate_lab_name(lab))


def cold_mount(cfg: AgentConfig, lab: str) -> str:
    """The lab's logical cold path (``/cold-storage/<lab>``), whatever backs it."""
    return cfg.storage.cold.logical_mount(validate_lab_name(lab))


def lab_branch_datasets(cfg: AgentConfig, tier: str, lab: str) -> list[str]:
    """Every ZFS dataset backing one lab on one tier, in configured pool order."""
    tier_cfg = cfg.storage.tier(tier)
    return [tier_cfg.branch_dataset(pool, validate_lab_name(lab)) for pool in tier_cfg.pools]


def lab_fast(cfg: AgentConfig, lab: str) -> str:
    """The lab's fast dataset on the FIRST fast pool.

    Only correct for a single-pool tier; multi-pool callers must use ``lab_branch_datasets`` (or,
    better, go through ``storage.service``). Kept because a handful of single-dataset operations
    (per-student promotion, mountpoint lookups) legitimately need one concrete name.
    """
    return cfg.storage.fast.branch_dataset(cfg.storage.fast.pools[0], validate_lab_name(lab))


def lab_slow(cfg: AgentConfig, lab: str) -> str:
    """The lab's cold dataset on the FIRST cold pool. See ``lab_fast`` for the caveat."""
    return cfg.storage.cold.branch_dataset(cfg.storage.cold.pools[0], validate_lab_name(lab))


def user_fast(cfg: AgentConfig, tier_pool: str, lab: str, user: str) -> str:
    return f"{cfg.storage.fast.branch_dataset(tier_pool, validate_lab_name(lab))}/{user}"


def user_slow(cfg: AgentConfig, tier_pool: str, lab: str, user: str) -> str:
    return f"{cfg.storage.cold.branch_dataset(tier_pool, validate_lab_name(lab))}/{user}"


def user_branch_datasets(cfg: AgentConfig, tier: str, lab: str, user: str) -> list[str]:
    """Every per-student dataset for one user on one tier, in configured pool order."""
    return [f"{ds}/{user}" for ds in lab_branch_datasets(cfg, tier, lab)]


# --- Cold storage as a filesystem path (SMB backend) -----------------------------------------
# When cold storage is SMB there are no local datasets: this path is the SMB view of the owner's
# exact same per-lab directory (which on the owner may itself be a mergerfs union).


def cold_lab(cfg: AgentConfig, lab: str) -> str:
    return f"{cfg.cold_root}/{validate_lab_name(lab)}"


def cold_user(cfg: AgentConfig, lab: str, user: str) -> str:
    return f"{cold_lab(cfg, lab)}/{user}"


__all__ = [
    "LAB_NAME_RE",
    "TIER_COLD",
    "TIER_FAST",
    "cold_lab",
    "cold_mount",
    "cold_user",
    "fast_mount",
    "lab_branch_datasets",
    "lab_fast",
    "lab_slow",
    "user_branch_datasets",
    "user_fast",
    "user_slow",
    "validate_lab_name",
]
