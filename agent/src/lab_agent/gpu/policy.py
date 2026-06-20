"""GPU idle-kill policy, pushed from the controller and cached on the agent.

Defaults are conservative; the controller overrides them via the gpu.policy.update task. The killer
loop reads the current policy each tick, so changes take effect without restarting the agent.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class GpuPolicy:
    enabled: bool = False
    util_threshold: float = 5.0  # SM% at or below which a VRAM-holding process counts as idle
    idle_minutes: float = 20.0  # idle this long -> warn
    grace_minutes: float = 10.0  # after warning, wait this long -> kill
    immediate: bool = False  # skip the grace period (kill as soon as idle threshold crossed)
    interval_s: int = 30  # how often the killer evaluates
    whitelist_users: set[str] = field(default_factory=set)
    whitelist_labs: set[str] = field(default_factory=set)

    @classmethod
    def from_dict(cls, d: dict) -> GpuPolicy:
        p = cls()
        for key in ("enabled", "immediate"):
            if key in d:
                p.__dict__[key] = bool(d[key])
        for key in ("util_threshold", "idle_minutes", "grace_minutes"):
            if key in d and d[key] is not None:
                p.__dict__[key] = float(d[key])
        if d.get("interval_s"):
            p.interval_s = int(d["interval_s"])
        p.whitelist_users = set(d.get("whitelist_users", []) or [])
        p.whitelist_labs = set(d.get("whitelist_labs", []) or [])
        return p


_current = GpuPolicy()


def get_policy() -> GpuPolicy:
    return _current


def set_policy(d: dict) -> GpuPolicy:
    global _current
    _current = GpuPolicy.from_dict(d)
    return _current


def update_policy_handler(cfg, params: dict):
    """Dispatcher handler for gpu.policy.update."""
    policy = set_policy(params)
    return {"enabled": policy.enabled, "idle_minutes": policy.idle_minutes}, "gpu policy updated"
