from lab_agent import protocol as P


def test_now_ms_is_milliseconds(monkeypatch):
    monkeypatch.setattr(P.time, "time", lambda: 1_700_000_000.5)
    assert P.now_ms() == 1_700_000_000_500


def test_task_from_frame_full():
    frame = {
        "id": "abc",
        "action": P.A_LAB_CREATE,
        "params": {"lab": "bio"},
        "requested_by": "admin",
        "ts": 42,
    }
    task = P.Task.from_frame(frame)
    assert task.id == "abc"
    assert task.action == "lab.create"
    assert task.params == {"lab": "bio"}
    assert task.requested_by == "admin"
    assert task.ts == 42


def test_task_from_frame_defaults_missing_optionals():
    task = P.Task.from_frame({"id": "1", "action": "x"})
    assert task.params == {}
    assert task.requested_by is None
    assert isinstance(task.ts, int) and task.ts > 0


def test_task_from_frame_coerces_null_params_to_empty_dict():
    task = P.Task.from_frame({"id": "1", "action": "x", "params": None})
    assert task.params == {}


def test_result_frame_shape():
    f = P.result_frame("t1", ok=True, result={"lab": "bio"}, logs="done")
    assert f["type"] == P.T_RESULT
    assert f["id"] == "t1"
    assert f["ok"] is True
    assert f["result"] == {"lab": "bio"}
    assert f["error"] is None
    assert f["logs"] == "done"
    assert f["cached"] is False
    assert isinstance(f["ts"], int)


def test_receipt_frame_shape():
    f = P.receipt_frame("t9")
    assert f["type"] == P.T_RECEIPT
    assert f["id"] == "t9"
    assert isinstance(f["ts"], int)


def test_result_frame_error_defaults():
    f = P.result_frame("t2", ok=False, error="boom")
    assert f["ok"] is False
    assert f["error"] == "boom"
    assert f["result"] is None
    assert f["logs"] is None


def test_hello_frame_carries_identity_caps_and_version():
    f = P.hello_frame("node-1", "secret", {"zfs": True})
    assert f["type"] == P.T_HELLO
    assert f["node"] == "node-1"
    assert f["token"] == "secret"
    assert f["capabilities"] == {"zfs": True}
    assert f["v"] == P.PROTOCOL_VERSION


def test_log_frame_optional_fields_default_none():
    f = P.log_frame("n", "INFO", "src", "hello")
    assert f["type"] == P.T_LOG
    assert f["level"] == "INFO"
    assert f["source"] == "src"
    assert f["msg"] == "hello"
    assert f["lab"] is None and f["user"] is None
    assert f["task_id"] is None and f["detail"] is None


def test_log_frame_with_context():
    f = P.log_frame("n", "ERROR", "zfs", "fail", lab="bio", user="al", task_id="9", detail="tb")
    assert f["lab"] == "bio"
    assert f["user"] == "al"
    assert f["task_id"] == "9"
    assert f["detail"] == "tb"


def test_event_frame_shape():
    f = P.event_frame("n", "gpu.kill", {"pid": 5})
    assert f["type"] == P.T_EVENT
    assert f["kind"] == "gpu.kill"
    assert f["payload"] == {"pid": 5}


def test_telemetry_frame_shape():
    f = P.telemetry_frame("n", {"pools": []})
    assert f["type"] == P.T_TELEMETRY
    assert f["payload"] == {"pools": []}


def test_frame_type_and_action_constants_are_distinct():
    types = {P.T_HELLO, P.T_TASK, P.T_RESULT, P.T_RECEIPT, P.T_LOG, P.T_EVENT, P.T_TELEMETRY, P.T_ACK}
    assert len(types) == 8
    actions = {
        P.A_LAB_CREATE, P.A_LAB_SET_QUOTA, P.A_LAB_DESTROY,
        P.A_STUDENT_ADD, P.A_STUDENT_REMOVE, P.A_CONTAINER_RECREATE,
        P.A_GPU_POLICY_UPDATE, P.A_NODE_REPORT_STATE,
        P.A_NODE_SCRUB, P.A_USAGE_SCAN,
    }
    assert len(actions) == 10
