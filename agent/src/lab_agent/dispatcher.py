"""Route a task action to its handler and always return a structured result.

Handlers are registered per action. A handler returns ``(result, logs)`` on success or raises;
any exception is caught and converted to ``ok=False`` so a single bad task never crashes the agent.
New actions (lab/student/container/usage) are registered here as later phases land.
"""

from __future__ import annotations

import os
import threading
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import protocol as P
from .config import DEFAULT_CONFIG_PATH, AgentConfig, config_stamp, refresh_config
from .logbus import LogBus
from .system import detect_capabilities

# A handler takes (cfg, params) and returns (result_payload, logs_text).
Handler = Callable[[AgentConfig, dict[str, Any]], tuple[Any, str]]


class Dispatcher:
    def __init__(self, cfg: AgentConfig, log: LogBus):
        self.cfg = cfg
        self.log = log
        self._config_path = Path(os.environ.get("LAB_AGENT_CONFIG", str(DEFAULT_CONFIG_PATH)))
        self._config_stamp = config_stamp(self._config_path)
        # Heartbeats and task execution run in separate worker threads. Keep a config reload from
        # mutating the shared object halfway through a handler, and make the post-handler check part
        # of the same critical section as the handler itself.
        self._config_lock = threading.RLock()
        self._handlers: dict[str, Handler] = {}
        self._register_builtin()

    def register(self, action: str, handler: Handler) -> None:
        self._handlers[action] = handler

    def _register_builtin(self) -> None:
        from . import containerops, labops, maintenance, storageops, studentops
        from .gpu import policy as gpu_policy

        self.register(P.A_NODE_REPORT_STATE, self._report_state)
        self.register(P.A_NODE_CHECK, maintenance.run_check)
        self.register(P.A_NODE_REPAIR, maintenance.run_repair)
        self.register(P.A_NODE_REBOOT, maintenance.run_reboot)
        self.register(P.A_NODE_SCRUB, maintenance.run_scrub)
        self.register(P.A_LAB_CREATE, labops.create_lab)
        self.register(P.A_LAB_SET_QUOTA, labops.set_lab_quota)
        self.register(P.A_LAB_DESTROY, labops.destroy_lab)
        self.register(P.A_CONTAINER_RECREATE, containerops.recreate_container)
        self.register(P.A_STUDENT_ADD, studentops.add_student)
        self.register(P.A_STUDENT_REMOVE, studentops.remove_student)
        self.register(P.A_STUDENT_DELETE_COLD, studentops.delete_cold_student)
        self.register(P.A_GPU_POLICY_UPDATE, gpu_policy.update_policy_handler)
        self.register(P.A_STORAGE_STATUS, storageops.status)
        self.register(P.A_STORAGE_LIST_DEVICES, storageops.list_devices)
        self.register(P.A_STORAGE_LIST_POOLS, storageops.list_pools)
        self.register(P.A_STORAGE_CREATE_POOL, storageops.create_pool)
        self.register(P.A_STORAGE_ATTACH_POOL, storageops.attach_pool)
        self.register(P.A_STORAGE_REMOVE_POOL, storageops.remove_pool)
        self.register(P.A_STORAGE_REBALANCE, storageops.rebalance)
        self.register(P.A_STORAGE_MOUNT, storageops.mount)
        self.register(P.A_STORAGE_PROVISION_LAB, storageops.provision_lab_storage)

    def _report_state(self, cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
        caps = detect_capabilities(cfg)
        return caps.to_dict(), ""

    def sync_config(self, *, wait: bool = True) -> None:
        """Adopt an out-of-band edit of the config file for tasks and periodic telemetry.

        `lab-agent storage attach/detach` and `host-prepare` are SEPARATE processes that rewrite
        the same file; the service used to keep its startup copy forever and answer `storage.status`
        and `node.check` from a topology that no longer existed — reporting a detached pool as
        UNAVAIL and the tier as degraded until someone restarted it.
        """
        # A task can legitimately take longer than a heartbeat interval. Periodic telemetry uses a
        # non-blocking check so config serialization never makes the controller mark a busy agent
        # offline; the task's mandatory post-handler check will pick up any edit it skipped.
        if not self._config_lock.acquire(blocking=wait):
            return
        try:
            stamp = config_stamp(self._config_path)
            if stamp is None or stamp == self._config_stamp:
                return
            try:
                changed = refresh_config(self.cfg, self._config_path)
            except (OSError, ValueError) as exc:
                # A half-written or invalid file must never take the running agent down; keep the
                # last good config and re-check on the next task or heartbeat.
                self.log.warn("config", f"ignoring unreadable {self._config_path}: {exc}")
                return
            # Keep the stamp captured BEFORE the read. If another process rewrites the file during
            # load, its later stamp remains different and the next check reads it instead of
            # accidentally declaring unseen contents current.
            self._config_stamp = stamp
            if changed:
                self.log.info(
                    "config", f"reloaded {self._config_path}: {', '.join(sorted(changed))}"
                )
        finally:
            self._config_lock.release()

    def handle(self, task: P.Task) -> dict[str, Any]:
        with self._config_lock:
            self.sync_config()
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
            finally:
                # A separate CLI may rewrite the file WHILE this handler runs. Reload it here;
                # merely recording its new stamp would permanently mark contents this process never
                # read as current. Storage handlers that wrote the file are harmlessly re-read.
                self.sync_config()
