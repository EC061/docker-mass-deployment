"""Idle-GPU-process state machine: active -> idle -> warned -> killed.

A process counts as *idle* when it holds VRAM but its SM utilization is at/below the threshold. The
machine tracks how long each PID has been idle and decides when to warn (notify the owner) and,
after the grace period, kill. ``evaluate`` is deterministic given (processes, policy, now) so it
can be unit-tested across simulated time; the surrounding loop performs the kill + event emission.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


def lab_from_container(container: str | None) -> str | None:
    if container and container.startswith("lab-"):
        return container[len("lab-"):]
    return None


@dataclass
class Decision:
    pid: int
    action: str  # "warn" | "kill"
    proc: dict[str, Any]
    lab: str | None
    user: str | None


class GpuKiller:
    def __init__(self):
        # pid -> {"idle_since": float|None, "warned_at": float|None}
        self._state: dict[int, dict[str, float | None]] = {}

    def _is_idle(self, proc: dict[str, Any], policy) -> bool:
        vram = proc.get("vram_bytes") or 0
        util = proc.get("util")
        # Unknown utilization is treated as active (conservative — never kill on missing data).
        return vram > 0 and util is not None and util <= policy.util_threshold

    def _whitelisted(self, proc: dict[str, Any], policy) -> bool:
        user = proc.get("user")
        lab = lab_from_container(proc.get("container"))
        return (user in policy.whitelist_users) or (lab in policy.whitelist_labs)

    def evaluate(self, processes: list[dict[str, Any]], policy, now: float) -> list[Decision]:
        decisions: list[Decision] = []
        present = set()

        for proc in processes:
            pid = proc.get("pid")
            if pid is None:
                continue
            present.add(pid)

            if (not policy.enabled or self._whitelisted(proc, policy)
                    or not self._is_idle(proc, policy)):
                # Active / exempt -> clear any idle tracking so the timer restarts next time.
                self._state.pop(pid, None)
                continue

            st = self._state.setdefault(pid, {"idle_since": now, "warned_at": None})
            if st["idle_since"] is None:
                st["idle_since"] = now
            idle_for = now - st["idle_since"]
            lab = lab_from_container(proc.get("container"))
            user = proc.get("user")

            if policy.immediate:
                decisions.append(Decision(pid, "kill", proc, lab, user))
                self._state.pop(pid, None)
                continue

            if st["warned_at"] is None:
                if idle_for >= policy.idle_minutes * 60:
                    st["warned_at"] = now
                    decisions.append(Decision(pid, "warn", proc, lab, user))
            else:
                if now - st["warned_at"] >= policy.grace_minutes * 60:
                    decisions.append(Decision(pid, "kill", proc, lab, user))
                    self._state.pop(pid, None)

        # Forget processes that are gone (finished or already killed).
        for pid in list(self._state):
            if pid not in present:
                self._state.pop(pid, None)

        return decisions
