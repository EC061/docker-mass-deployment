import json

from lab_agent.localq import OUTBOX_QUEUE, TASKS_QUEUE, LocalQueues


def test_init_creates_parent_dir_and_queues(tmp_path):
    db = tmp_path / "nested" / "state.db"
    q = LocalQueues(str(db))
    try:
        assert db.parent.is_dir()
        assert q.worker_id.startswith("agent-")
    finally:
        q.close()


def test_task_roundtrip_enqueue_then_claim(tmp_path):
    q = LocalQueues(str(tmp_path / "state.db"))
    try:
        frame = {"type": "task", "id": "t1", "action": "lab.create"}
        q.enqueue_task(frame)
        job = q.claim_task()
        assert job is not None
        assert q.payload_of(job) == frame
        job.ack()
    finally:
        q.close()


def test_payloads_are_encrypted_at_rest(tmp_path):
    """The stored honker payload must be an opaque envelope — never the plaintext frame."""
    q = LocalQueues(str(tmp_path / "state.db"))
    try:
        frame = {"type": "task", "id": "t1", "action": "student.add",
                 "params": {"username": "alice", "password": "hunter2"}}
        q.enqueue_task(frame)
        job = q.claim_task()
        raw = json.dumps(job.payload)
        assert "_enc" in job.payload          # envelope marker
        assert "hunter2" not in raw           # the password is not stored in cleartext
        assert "student.add" not in raw
        assert q.payload_of(job) == frame     # but it round-trips back exactly
        job.ack()
    finally:
        q.close()


def test_key_file_and_state_dir_have_tight_perms(tmp_path):
    import os

    state = tmp_path / "state"
    q = LocalQueues(str(state / "state.db"))
    try:
        assert (os.stat(state).st_mode & 0o777) == 0o700
        assert (os.stat(state / "queue.key").st_mode & 0o777) == 0o600
    finally:
        q.close()


def test_claim_task_returns_none_when_empty(tmp_path):
    q = LocalQueues(str(tmp_path / "state.db"))
    try:
        assert q.claim_task() is None
    finally:
        q.close()


def test_outbound_roundtrip(tmp_path):
    q = LocalQueues(str(tmp_path / "state.db"))
    try:
        frame = {"type": "result", "id": "r1", "ok": True}
        q.enqueue_outbound(frame)
        job = q.claim_outbound()
        assert job is not None
        assert q.payload_of(job) == frame
        job.ack()
        assert q.claim_outbound() is None
    finally:
        q.close()


def test_tasks_and_outbox_are_independent(tmp_path):
    q = LocalQueues(str(tmp_path / "state.db"))
    try:
        q.enqueue_task({"id": "task"})
        # An outbound claim must not see the task frame.
        assert q.claim_outbound() is None
        job = q.claim_task()
        assert q.payload_of(job) == {"id": "task"}
        job.ack()
    finally:
        q.close()


def test_durable_across_reopen(tmp_path):
    path = str(tmp_path / "state.db")
    q1 = LocalQueues(path)
    q1.enqueue_task({"id": "survivor"})
    q1.close()

    # The persisted key (queue.key) is reused, so the encrypted payload still decrypts after reopen.
    q2 = LocalQueues(path)
    try:
        job = q2.claim_task()
        assert job is not None
        assert q2.payload_of(job) == {"id": "survivor"}
        job.ack()
    finally:
        q2.close()


def test_result_journal_caches_and_replays(tmp_path):
    q = LocalQueues(str(tmp_path / "state.db"))
    try:
        assert q.cached_result("abc") is None
        result = {"type": "result", "id": "abc", "ok": True, "result": {"lab": "bio"}}
        q.record_result("abc", result)
        assert q.cached_result("abc") == result
        # A second, different task id is independent.
        assert q.cached_result("xyz") is None
    finally:
        q.close()


def test_queue_name_constants():
    assert TASKS_QUEUE == "tasks"
    assert OUTBOX_QUEUE == "outbox"
