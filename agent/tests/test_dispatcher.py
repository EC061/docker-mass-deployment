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
    assert "runtime" in frame["result"]
    assert "nvidia" in frame["result"]
    assert "health" in frame["result"]


def _write_config(path, pools: list[str]) -> None:
    quoted = ", ".join(f'"{p}"' for p in pools)
    path.write_text(
        '[agent]\n'
        'controller_url = "ws://x"\n'
        'token = "t"\n'
        'node_name = "test-node"\n'
        '\n[storage.fast]\n'
        'backend = "mergerfs"\n'
        f'pools = [{quoted}]\n'
        '\n[storage.cold]\n'
        'backend = "zfs"\n'
        'pools = ["cold1"]\n'
        '\n[storage.docker]\n'
        'pool = "fast1"\n'
    )


def test_a_config_edited_by_the_cli_is_adopted_before_the_next_task(tmp_path, monkeypatch):
    """RETEST-FIND-9: `lab-agent storage detach` is a separate process rewriting the same file.

    The running service used to answer storage.status and node.check from its startup copy, so a
    pool detached minutes earlier was still reported UNAVAIL (and its tier degraded) until someone
    restarted the unit.
    """
    from lab_agent.config import load_config

    path = tmp_path / "config.toml"
    _write_config(path, ["fast1", "fast2", "fast3"])
    monkeypatch.setenv("LAB_AGENT_CONFIG", str(path))
    cfg = load_config(path)
    log = LogBus("test-node", sink=lambda _e: None, echo=False)
    disp = Dispatcher(cfg, log)
    assert cfg.storage.fast.pools == ("fast1", "fast2", "fast3")

    _write_config(path, ["fast1", "fast2"])  # the detach the operator just ran
    seen = {}
    disp.register("test.peek", lambda c, p: (seen.setdefault("pools", c.storage.fast.pools), ""))
    assert disp.handle(P.Task(id="9", action="test.peek"))["ok"] is True

    assert seen["pools"] == ("fast1", "fast2")
    # Mutated IN PLACE: telemetry, the heartbeat and the GPU loops hold this same object.
    assert cfg.storage.fast.pools == ("fast1", "fast2")


def test_an_unreadable_config_leaves_the_running_agent_on_its_last_good_copy(tmp_path, monkeypatch):
    from lab_agent.config import load_config

    path = tmp_path / "config.toml"
    _write_config(path, ["fast1", "fast2"])
    monkeypatch.setenv("LAB_AGENT_CONFIG", str(path))
    cfg = load_config(path)
    logs = []
    disp = Dispatcher(cfg, LogBus("test-node", sink=logs.append, echo=False))

    path.write_text("[agent]\nthis is not = = toml\n")
    assert disp.handle(P.Task(id="10", action=P.A_NODE_REPORT_STATE))["ok"] is True
    assert cfg.storage.fast.pools == ("fast1", "fast2")
    assert any("ignoring unreadable" in entry["msg"] for entry in logs)
