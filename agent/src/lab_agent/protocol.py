"""Wire protocol shared between agent and controller.

All frames are JSON objects with a top-level ``type`` discriminator. The agent opens the WebSocket
(dials home); the controller pushes ``task`` frames down it; the agent replies with ``result`` and
streams unsolicited ``log``, ``event``, ``telemetry`` and ``hello`` frames up the same socket.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

# Wire-protocol version. Bumped on any breaking frame change; the controller refuses a mismatch
# (this redesign is a clean break — agents are reinstalled, so there is no legacy compatibility).
PROTOCOL_VERSION = 2

# Frame types (agent <-> controller).
T_HELLO = "hello"  # agent -> controller: identity + capabilities on connect
T_TASK = "task"  # controller -> agent: a unit of work
T_RESULT = "result"  # agent -> controller: outcome of a task
T_RECEIPT = "receipt"  # agent -> controller: durable receipt of a pushed task (persisted locally)
T_LOG = "log"  # agent -> controller: a structured log line
T_EVENT = "event"  # agent -> controller: gpu/quota event
T_TELEMETRY = "telemetry"  # agent -> controller: heartbeat snapshot
T_ACK = "ack"  # controller -> agent: acknowledge receipt (optional)

# Task actions.
A_LAB_CREATE = "lab.create"
A_LAB_SET_QUOTA = "lab.set_quota"
A_LAB_DESTROY = "lab.destroy"
A_STUDENT_ADD = "student.add"
A_STUDENT_REMOVE = "student.remove"
A_STUDENT_DELETE_COLD = "student.delete_cold"
A_CONTAINER_RECREATE = "container.recreate"
A_GPU_POLICY_UPDATE = "gpu.policy.update"
A_NODE_REPORT_STATE = "node.report_state"
A_NODE_SCRUB = "node.scrub"
A_NODE_CHECK = "node.check"
A_NODE_REPAIR = "node.repair"
A_NODE_REBOOT = "node.reboot"
A_USAGE_SCAN = "usage.scan"  # per-student storage (du) scan for one lab (nightly + on-demand)
# Storage management. Read-only inventory + the mutating operations behind the controller's
# Node -> Storage UI. Everything destructive validates its inputs agent-side and, for pool creation,
# additionally requires an explicit confirmation flag in the params.
A_STORAGE_STATUS = "storage.status"
A_STORAGE_LIST_DEVICES = "storage.list_devices"
A_STORAGE_LIST_POOLS = "storage.list_pools"
A_STORAGE_CREATE_POOL = "storage.create_pool"      # DESTRUCTIVE: erases the selected disks
A_STORAGE_ATTACH_POOL = "storage.attach_pool"      # add a pool to a tier + extend every lab
A_STORAGE_REMOVE_POOL = "storage.remove_pool"      # admin detach (distinct from "disk vanished")
A_STORAGE_REBALANCE = "storage.rebalance"          # reshard branch quotas (moves quota, not files)
A_STORAGE_MOUNT = "storage.mount"                  # reconcile ZFS roots + per-lab union mounts
A_STORAGE_PROVISION_LAB = "storage.provision_lab"  # converge one lab's storage on one tier


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class Task:
    id: str
    action: str
    params: dict[str, Any] = field(default_factory=dict)
    requested_by: str | None = None
    ts: int = field(default_factory=now_ms)

    @classmethod
    def from_frame(cls, frame: dict[str, Any]) -> Task:
        return cls(
            id=frame["id"],
            action=frame["action"],
            params=frame.get("params", {}) or {},
            requested_by=frame.get("requested_by"),
            ts=frame.get("ts", now_ms()),
        )


def result_frame(task_id: str, ok: bool, result: Any = None, error: str | None = None,
                 logs: str | None = None, cached: bool = False) -> dict[str, Any]:
    return {
        "type": T_RESULT,
        "id": task_id,
        "ok": ok,
        "result": result,
        "error": error,
        "logs": logs,
        "cached": cached,
        "ts": now_ms(),
    }


def receipt_frame(task_id: str) -> dict[str, Any]:
    """Durable-receipt ack: the agent persisted this task to its local queue."""
    return {"type": T_RECEIPT, "id": task_id, "ts": now_ms()}


def hello_frame(node_name: str, token: str, capabilities: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": T_HELLO,
        "v": PROTOCOL_VERSION,
        "node": node_name,
        "token": token,
        "capabilities": capabilities,
        "ts": now_ms(),
    }


def log_frame(node: str, level: str, source: str, msg: str, *, lab: str | None = None,
              user: str | None = None, task_id: str | None = None,
              detail: str | None = None) -> dict[str, Any]:
    return {
        "type": T_LOG,
        "node": node,
        "level": level,
        "source": source,
        "lab": lab,
        "user": user,
        "task_id": task_id,
        "msg": msg,
        "detail": detail,
        "ts": now_ms(),
    }


def event_frame(node: str, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"type": T_EVENT, "node": node, "kind": kind, "payload": payload, "ts": now_ms()}


def telemetry_frame(node: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"type": T_TELEMETRY, "node": node, "payload": payload, "ts": now_ms()}
