"""Flattened ZFS dataset and filesystem paths.

Each lab has exactly one quota-bearing dataset per storage tier. Student storage is a directory
directly below that lab root; there are no ``shared`` or ``users`` child datasets.

    fast/labs/<lab> -> host /fast/<lab> -> container /fast
    slow/labs/<lab> -> its ZFS mount     -> container /cold
    /fast/<user>    -> /home/<user>/scratch
    /cold/<user>    -> /home/<user>/cold-storage
"""

from __future__ import annotations

import re

from .config import AgentConfig

# Defense-in-depth: the controller already allow-lists lab names (lib/labs.ts), but the agent runs
# as root, so it re-validates before a name is ever interpolated into a dataset/container argument
# (M-04). Same shape as the controller's LAB_NAME_RE.
LAB_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$")


def validate_lab_name(lab: str) -> str:
    if not LAB_NAME_RE.match(lab):
        raise ValueError(f"invalid lab name '{lab}'")
    return lab


def lab_fast(cfg: AgentConfig, lab: str) -> str:
    return f"{cfg.labs_fast_root}/{validate_lab_name(lab)}"


def lab_slow(cfg: AgentConfig, lab: str) -> str:
    return f"{cfg.labs_slow_root}/{validate_lab_name(lab)}"


def fast_mount(cfg: AgentConfig, lab: str) -> str:
    return f"{cfg.fast_mount_root.rstrip('/')}/{validate_lab_name(lab)}"


# --- Cold storage as a filesystem path (SMB backend) -----------------------------------------
# When cold storage is SMB there are no datasets, only one directory per lab.


def cold_lab(cfg: AgentConfig, lab: str) -> str:
    return f"{cfg.cold_root}/{validate_lab_name(lab)}"


def cold_user(cfg: AgentConfig, lab: str, user: str) -> str:
    return f"{cold_lab(cfg, lab)}/{user}"
