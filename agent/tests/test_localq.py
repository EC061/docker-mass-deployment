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
        assert job.payload == frame
        job.ack()
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
        assert job.payload == frame
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
        assert job.payload == {"id": "task"}
        job.ack()
    finally:
        q.close()


def test_durable_across_reopen(tmp_path):
    path = str(tmp_path / "state.db")
    q1 = LocalQueues(path)
    q1.enqueue_task({"id": "survivor"})
    q1.close()

    q2 = LocalQueues(path)
    try:
        job = q2.claim_task()
        assert job is not None
        assert job.payload == {"id": "survivor"}
        job.ack()
    finally:
        q2.close()


def test_queue_name_constants():
    assert TASKS_QUEUE == "tasks"
    assert OUTBOX_QUEUE == "outbox"
