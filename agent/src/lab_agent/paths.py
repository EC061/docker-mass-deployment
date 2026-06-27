"""ZFS dataset / path naming for labs and students.

Datasets (per node), rooted on the configured pools — one fast + one slow per lab, each with a
`shared` and a `users` child. There are **no per-student datasets**: every student is a plain subdir
of the lab's single `users` dataset, so the whole lab (shared + all students) is bounded by the one
lab quota and per-student subdirs need no host-side setup.

    <fast>/labs/<lab>            (quota = lab fast quota)
    <fast>/labs/<lab>/shared       -> mounted /labdata/fast
    <fast>/labs/<lab>/users        -> mounted /labusers/fast   (each student: a /<u> subdir here)
    <slow>/labs/<lab>            (quota = lab slow quota)
    <slow>/labs/<lab>/shared       -> mounted /labdata/slow
    <slow>/labs/<lab>/users        -> mounted /labusers/slow   (each student: a /<u> subdir here)

``user_scratch``/``user_cold`` return the filesystem path of a student's subdir under those `users`
datasets (``<...>/users/<u>``) — a directory, not a dataset of its own.
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


def lab_fast_shared(cfg: AgentConfig, lab: str) -> str:
    return f"{lab_fast(cfg, lab)}/shared"


def lab_slow_shared(cfg: AgentConfig, lab: str) -> str:
    return f"{lab_slow(cfg, lab)}/shared"


def lab_fast_users(cfg: AgentConfig, lab: str) -> str:
    """Parent dataset holding every student's scratch; bind-mounted into the container once."""
    return f"{lab_fast(cfg, lab)}/users"


def lab_slow_users(cfg: AgentConfig, lab: str) -> str:
    """Parent dataset holding every student's cold-storage; bind-mounted into the container once."""
    return f"{lab_slow(cfg, lab)}/users"


def user_scratch(cfg: AgentConfig, lab: str, user: str) -> str:
    return f"{lab_fast(cfg, lab)}/users/{user}"


def user_cold(cfg: AgentConfig, lab: str, user: str) -> str:
    return f"{lab_slow(cfg, lab)}/users/{user}"


# --- Cold storage as a filesystem path (SMB backend) -----------------------------------------
# When cold storage is an SMB mount there are no datasets, only directories. The layout mirrors
# the ZFS one so the controller's dataset-name parser ("…/labs/<lab>[/users/<u>]") works for both.


def cold_lab(cfg: AgentConfig, lab: str) -> str:
    return f"{cfg.cold_root}/{validate_lab_name(lab)}"


def cold_lab_shared(cfg: AgentConfig, lab: str) -> str:
    return f"{cold_lab(cfg, lab)}/shared"


def cold_lab_users(cfg: AgentConfig, lab: str) -> str:
    return f"{cold_lab(cfg, lab)}/users"


def cold_user(cfg: AgentConfig, lab: str, user: str) -> str:
    return f"{cold_lab(cfg, lab)}/users/{user}"
