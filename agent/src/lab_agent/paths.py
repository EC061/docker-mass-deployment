"""ZFS dataset naming for labs and students.

Layout (per node), rooted on the configured pools:

    <fast>/labs/<lab>            (quota = lab fast quota)
    <fast>/labs/<lab>/shared     -> mounted /labdata/fast
    <fast>/labs/<lab>/users/<u>  -> mounted /home/<u>/scratch
    <slow>/labs/<lab>            (quota = lab slow quota)
    <slow>/labs/<lab>/shared     -> mounted /labdata/slow
    <slow>/labs/<lab>/users/<u>  -> mounted /home/<u>/cold-storage
"""

from __future__ import annotations

from .config import AgentConfig


def lab_fast(cfg: AgentConfig, lab: str) -> str:
    return f"{cfg.labs_fast_root}/{lab}"


def lab_slow(cfg: AgentConfig, lab: str) -> str:
    return f"{cfg.labs_slow_root}/{lab}"


def lab_fast_shared(cfg: AgentConfig, lab: str) -> str:
    return f"{lab_fast(cfg, lab)}/shared"


def lab_slow_shared(cfg: AgentConfig, lab: str) -> str:
    return f"{lab_slow(cfg, lab)}/shared"


def user_scratch(cfg: AgentConfig, lab: str, user: str) -> str:
    return f"{lab_fast(cfg, lab)}/users/{user}"


def user_cold(cfg: AgentConfig, lab: str, user: str) -> str:
    return f"{lab_slow(cfg, lab)}/users/{user}"
