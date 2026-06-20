"""Route a task action to its handler and always return a structured result.

Handlers are registered per action. A handler returns ``(result, logs)`` on success or raises;
any exception is caught and converted to ``ok=False`` so a single bad task never crashes the agent.
New actions (lab/student/container/scan) are registered here as later phases land.
"""

from __future__ import annotations

import traceback
from collections.abc import Callable
from typing import Any

from . import protocol as P
from .config import AgentConfig
from .logbus import LogBus
from .system import detect_capabilities

# A handler takes (cfg, params) and returns (result_payload, logs_text).
Handler = Callable[[AgentConfig, dict[str, Any]], tuple[Any, str]]


class Dispatcher:
    def __init__(self, cfg: AgentConfig, log: LogBus):
        self.cfg = cfg
        self.log = log
        self._handlers: dict[str, Handler] = {}
        self._register_builtin()

    def register(self, action: str, handler: Handler) -> None:
        self._handlers[action] = handler

    def _register_builtin(self) -> None:
        from . import backup, containerops, labops, scan, studentops
        from .gpu import policy as gpu_policy

        self.register(P.A_NODE_REPORT_STATE, self._report_state)
        self.register(P.A_NODE_BACKUP, backup.backup_state)
        self.register(P.A_LAB_CREATE, labops.create_lab)
        self.register(P.A_LAB_SET_QUOTA, labops.set_lab_quota)
        self.register(P.A_LAB_DESTROY, labops.destroy_lab)
        self.register(P.A_CONTAINER_RECREATE, containerops.recreate_container)
        self.register(P.A_STUDENT_ADD, studentops.add_student)
        self.register(P.A_STUDENT_REMOVE, studentops.remove_student)
        self.register(P.A_GPU_POLICY_UPDATE, gpu_policy.update_policy_handler)
        self.register(P.A_OLDFILES_SCAN, scan.scan_lab)

    def _report_state(self, cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
        caps = detect_capabilities(cfg)
        return caps.to_dict(), ""

    def handle(self, task: P.Task) -> dict[str, Any]:
        handler = self._handlers.get(task.action)
        if handler is None:
            self.log.warn("dispatch", f"no handler for action '{task.action}'",
                          task_id=task.id)
            return P.result_frame(task.id, ok=False,
                                  error=f"unknown action '{task.action}'")
        try:
            result, logs = handler(self.cfg, task.params)
            return P.result_frame(task.id, ok=True, result=result, logs=logs or None)
        except Exception as exc:  # graceful failure contract
            tb = traceback.format_exc()
            self.log.error("dispatch", f"task {task.action} failed: {exc}",
                           task_id=task.id, detail=tb)
            return P.result_frame(task.id, ok=False, error=str(exc), logs=tb)
