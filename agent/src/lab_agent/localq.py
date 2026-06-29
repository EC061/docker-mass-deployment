"""Durable local buffers backed by honker (SQLite): at-rest encryption + an idempotency journal.

Two honker queues:
  - ``tasks``  : tasks received over the WebSocket are enqueued here, then a worker claims and
                 executes them. Gives at-least-once execution that survives an agent restart.
  - ``outbox`` : frames to send to the controller (results, logs, events, telemetry, receipts). A
                 sender drains this over the WebSocket and acks each item only after a successful
                 send, so nothing is lost while disconnected.

Every persisted payload is AES-GCM encrypted (``crypto``) because task payloads carry student
passwords; the state dir is 0700 and the queue DB / key are 0600. The DB is never sent off-node.

A separate ``TaskJournal`` (its own SQLite file, to avoid contending with honker's native engine on
one file) records each completed task's result keyed by task id. A redelivered task (ack lost, agent
restart) is replayed from this cache instead of re-executed, for idempotent, dedup'd task handling.

honker API used (v0.2.x): ``honker.open(path)`` -> Database; ``db.queue(name)`` -> Queue;
``q.enqueue(payload)`` ; ``q.claim_one(worker_id)`` -> Job|None ; ``job.payload`` / ``job.ack()`` /
``job.retry(delay_s, error)`` / ``job.fail(error)``.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any

import honker

from . import crypto
from .protocol import now_ms

TASKS_QUEUE = "tasks"
OUTBOX_QUEUE = "outbox"
KEY_FILE = "queue.key"
JOURNAL_FILE = "taskjournal.db"


def _chmod(path: Path | str, mode: int) -> None:
    """Best-effort chmod (in tests the files live in a tmp dir owned by the runner)."""
    try:
        os.chmod(path, mode)
    except OSError:
        pass


class TaskJournal:
    """Persistent record of completed task results (encrypted), keyed by task id.

    Lets the worker replay a redelivered task's result instead of re-executing it. Entries older
    than ``retain_days`` are pruned on write so the journal stays small.
    """

    def __init__(self, path: str, key: bytes, *, retain_days: int = 7) -> None:
        self.key = key
        self.retain_ms = retain_days * 86_400 * 1000
        self._lock = threading.Lock()
        # check_same_thread=False: the asyncio worker touches this from to_thread pool threads; the
        # lock below serializes access.
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS results "
            "(task_uuid TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL)"
        )
        self.conn.commit()
        _chmod(path, 0o600)

    def get(self, task_uuid: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.conn.execute(
                "SELECT payload FROM results WHERE task_uuid = ?", (task_uuid,)
            ).fetchone()
        if row is None:
            return None
        try:
            return crypto.decrypt_payload(self.key, json.loads(row[0]))
        except Exception:  # corrupt/undecryptable -> treat as a cache miss, re-execute
            return None

    def put(self, task_uuid: str, result_frame: dict[str, Any]) -> None:
        now = now_ms()
        envelope = json.dumps(crypto.encrypt_payload(self.key, result_frame), separators=(",", ":"))
        with self._lock:
            self.conn.execute(
                "INSERT OR REPLACE INTO results (task_uuid, payload, created_at) VALUES (?, ?, ?)",
                (task_uuid, envelope, now),
            )
            self.conn.execute("DELETE FROM results WHERE created_at < ?", (now - self.retain_ms,))
            self.conn.commit()

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:  # pragma: no cover - best-effort
            pass


class LocalQueues:
    def __init__(self, db_path: str, *, retain_days: int = 7):
        state_dir = Path(db_path).parent
        state_dir.mkdir(parents=True, exist_ok=True)
        _chmod(state_dir, 0o700)  # private: holds the queue, key, and journal
        self.db = honker.open(db_path)
        for suffix in ("", "-wal", "-shm"):
            _chmod(f"{db_path}{suffix}", 0o600)
        self.tasks = self.db.queue(TASKS_QUEUE)
        self.outbox = self.db.queue(OUTBOX_QUEUE)
        self.worker_id = f"agent-{os.getpid()}"
        self._key = crypto.load_or_create_key(state_dir / KEY_FILE)
        self.journal = TaskJournal(
            str(state_dir / JOURNAL_FILE), self._key, retain_days=retain_days
        )

    # --- inbound tasks (payloads encrypted at rest) ---
    def enqueue_task(self, task_frame: dict[str, Any]) -> int:
        return self.tasks.enqueue(crypto.encrypt_payload(self._key, task_frame))

    def claim_task(self):
        return self.tasks.claim_one(self.worker_id)

    # --- outbound frames (payloads encrypted at rest) ---
    def enqueue_outbound(self, frame: dict[str, Any]) -> int:
        return self.outbox.enqueue(crypto.encrypt_payload(self._key, frame))

    def claim_outbound(self):
        return self.outbox.claim_one(self.worker_id)

    def payload_of(self, job: Any) -> Any:
        """Decrypt a claimed job's payload back into the original frame dict."""
        return crypto.decrypt_payload(self._key, job.payload)

    # --- idempotency journal ---
    def cached_result(self, task_uuid: str) -> dict[str, Any] | None:
        return self.journal.get(task_uuid)

    def record_result(self, task_uuid: str, result_frame: dict[str, Any]) -> None:
        self.journal.put(task_uuid, result_frame)

    def close(self) -> None:
        self.journal.close()
        try:
            self.db.close()
        except Exception:  # pragma: no cover - best-effort
            pass
