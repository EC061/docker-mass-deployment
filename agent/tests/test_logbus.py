from lab_agent import protocol as P
from lab_agent.logbus import LogBus


def _bus():
    frames: list[dict] = []
    return LogBus("node-1", sink=frames.append, echo=False), frames


def test_log_emits_log_frame_to_sink():
    bus, frames = _bus()
    bus.log("INFO", "src", "hello", lab="bio", user="al", task_id="7", detail="d")
    assert len(frames) == 1
    f = frames[0]
    assert f["type"] == P.T_LOG
    assert f["node"] == "node-1"
    assert f["level"] == "INFO"
    assert f["source"] == "src"
    assert f["msg"] == "hello"
    assert f["lab"] == "bio" and f["user"] == "al" and f["task_id"] == "7" and f["detail"] == "d"


def test_level_helpers_set_level():
    bus, frames = _bus()
    bus.debug("s", "d")
    bus.info("s", "i")
    bus.warn("s", "w")
    bus.error("s", "e")
    assert [f["level"] for f in frames] == ["DEBUG", "INFO", "WARN", "ERROR"]


def test_helpers_forward_kwargs():
    bus, frames = _bus()
    bus.warn("zfs", "quota near", lab="bio", task_id="3")
    assert frames[0]["lab"] == "bio"
    assert frames[0]["task_id"] == "3"


def test_event_emits_event_frame():
    bus, frames = _bus()
    bus.event("gpu.warn", {"pid": 42})
    assert frames[0]["type"] == P.T_EVENT
    assert frames[0]["kind"] == "gpu.warn"
    assert frames[0]["payload"] == {"pid": 42}


def test_telemetry_emits_telemetry_frame():
    bus, frames = _bus()
    bus.telemetry({"pools": [1]})
    assert frames[0]["type"] == P.T_TELEMETRY
    assert frames[0]["payload"] == {"pools": [1]}


def test_echo_writes_to_stderr(capsys):
    frames: list[dict] = []
    bus = LogBus("n", sink=frames.append, echo=True)
    bus.info("src", "visible")
    captured = capsys.readouterr()
    assert "[INFO] src: visible" in captured.err
    # Still delivered to the sink.
    assert frames[0]["msg"] == "visible"


def test_echo_disabled_is_silent(capsys):
    bus, _ = _bus()
    bus.info("src", "quiet")
    assert capsys.readouterr().err == ""
