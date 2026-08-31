import pytest
from test_dispatcher import _write_config

from lab_agent import telemetry
from lab_agent.client import Agent
from lab_agent.config import load_config
from lab_agent.dispatcher import Dispatcher
from lab_agent.logbus import LogBus


@pytest.mark.asyncio
async def test_heartbeat_adopts_a_cli_config_edit_without_waiting_for_a_task(
    tmp_path, monkeypatch,
):
    path = tmp_path / "config.toml"
    _write_config(path, ["fast1", "fast2", "fast3"])
    monkeypatch.setenv("LAB_AGENT_CONFIG", str(path))
    cfg = load_config(path)

    # Build only the state _heartbeat uses; a full Agent would start durable local queues that are
    # irrelevant to this config-reload contract.
    agent = object.__new__(Agent)
    agent.cfg = cfg
    agent.dispatcher = Dispatcher(
        cfg, LogBus("test-node", sink=lambda _entry: None, echo=False),
    )
    agent.usage = object()

    class HeartbeatSent(Exception):
        pass

    captured = []

    class CaptureLog:
        def telemetry(self, payload):
            captured.append(payload)
            raise HeartbeatSent

    agent.log = CaptureLog()
    monkeypatch.setattr(
        telemetry,
        "collect_heartbeat",
        lambda live_cfg, _usage: {"fast_pools": list(live_cfg.fast_tier.pools)},
    )

    _write_config(path, ["fast1", "fast2"])
    with pytest.raises(HeartbeatSent):
        await agent._heartbeat(None)

    assert captured == [{"fast_pools": ["fast1", "fast2"]}]
    assert cfg.fast_tier.pools == ("fast1", "fast2")
