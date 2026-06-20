from lab_agent import protocol as P
from lab_agent.config import AgentConfig
from lab_agent.dispatcher import Dispatcher
from lab_agent.logbus import LogBus


def _dispatcher():
    cfg = AgentConfig(controller_url="ws://x", token="t", node_name="test-node")
    sink_log = []
    log = LogBus("test-node", sink=sink_log.append, echo=False)
    return Dispatcher(cfg, log), sink_log


def test_unknown_action_is_graceful():
    disp, _ = _dispatcher()
    task = P.Task(id="1", action="does.not.exist")
    frame = disp.handle(task)
    assert frame["type"] == P.T_RESULT
    assert frame["ok"] is False
    assert "unknown action" in frame["error"]


def test_handler_exception_is_caught():
    disp, logs = _dispatcher()

    def boom(cfg, params):
        raise RuntimeError("kaboom")

    disp.register("test.boom", boom)
    frame = disp.handle(P.Task(id="2", action="test.boom"))
    assert frame["ok"] is False
    assert "kaboom" in frame["error"]
    assert frame["logs"]  # traceback attached
    assert any(entry["level"] == "ERROR" for entry in logs)


def test_report_state_returns_capabilities():
    disp, _ = _dispatcher()
    frame = disp.handle(P.Task(id="3", action=P.A_NODE_REPORT_STATE))
    assert frame["ok"] is True
    assert "zfs" in frame["result"]
    assert "gpu_count" in frame["result"]
