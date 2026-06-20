"""Durable local buffers backed by honker (SQLite).

Two queues:
  - ``tasks``  : tasks received over the WebSocket are enqueued here, then a worker claims and
                 executes them. Gives at-least-once execution that survives an agent restart.
  - ``outbox`` : frames to send to the controller (results, logs, events, telemetry). A sender
                 drains this over the WebSocket and acks each item only after a successful send,
                 so nothing is lost while disconnected.

honker API used (v0.2.x): ``honker.open(path)`` -> Database; ``db.queue(name)`` -> Queue;
``q.enqueue(payload)`` ; ``q.claim_one(worker_id)`` -> Job|None ; ``job.payload`` / ``job.ack()`` /
``job.retry(delay_s, error)`` / ``job.fail(error)``.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import honker

TASKS_QUEUE = "tasks"
OUTBOX_QUEUE = "outbox"


class LocalQueues:
    def __init__(self, db_path: str):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.db = honker.open(db_path)
        self.tasks = self.db.queue(TASKS_QUEUE)
        self.outbox = self.db.queue(OUTBOX_QUEUE)
        self.worker_id = f"agent-{os.getpid()}"

    # --- inbound tasks ---
    def enqueue_task(self, task_frame: dict[str, Any]) -> int:
        return self.tasks.enqueue(task_frame)

    def claim_task(self):
        return self.tasks.claim_one(self.worker_id)

    # --- outbound frames ---
    def enqueue_outbound(self, frame: dict[str, Any]) -> int:
        return self.outbox.enqueue(frame)

    def claim_outbound(self):
        return self.outbox.claim_one(self.worker_id)

    def close(self) -> None:
        try:
            self.db.close()
        except Exception:  # pragma: no cover - best-effort
            pass
