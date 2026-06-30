from types import SimpleNamespace

from lab_agent import telemetry, usagereport
from lab_agent.config import AgentConfig
from lab_agent.executors.base import CommandResult


def cfg(**kw):
    return AgentConfig(controller_url="ws://x", token="t", node_name="n", **kw)


def test_pool_telemetry_and_smb_exclusion(monkeypatch):
    seen = []
    def fake(args, **kwargs):
        pool = args[-1]
        seen.append(pool)
        return CommandResult(True, list(args), 0, f"{pool} 100 40 60", "")
    monkeypatch.setattr(telemetry, "run", fake)
    assert telemetry._pool_free("fast")["free"] == 60
    assert [p["name"] for p in telemetry._pools(cfg(slow_backend="smb"))] == ["fast"]


def test_heartbeat_uses_explicit_storage_rows(monkeypatch):
    monkeypatch.setattr(telemetry, "run", lambda args, **kw:
        CommandResult(True, list(args), 0, f"{args[-1]} 10 1 9", ""))
    monkeypatch.setattr(telemetry.zfs, "scrub_status",
                        lambda p: SimpleNamespace(to_dict=lambda: {"pool": p}))
    monkeypatch.setattr(telemetry, "list_gpu_processes", lambda: [])
    state = usagereport.UsageState()
    state.set_lab_level("bio", usagereport.LabLevelUsage(computed_at=1, storage=[
        {"lab": "bio", "user": None, "tier": "fast", "used_bytes": 100,
         "quota_bytes": 200, "available_bytes": 100},
    ]))
    state.set_container("bio", usagereport.ContainerUsage(
        scanned_at=7, per_user={"alice": 12}, per_user_fast={"alice": 4},
        per_user_slow={"alice": 1},
    ))
    hb = telemetry.collect_heartbeat(cfg(), state)
    rows = {(r["tier"], r["user"]): r["used_bytes"] for r in hb["storage"]}
    assert rows[("fast", None)] == 100
    assert rows[("rootfs", "alice")] == 12
    assert rows[("cold", "alice")] == 1
    assert "datasets" not in hb
    assert hb["usage_scans"] == [{"lab": "bio", "scanned_at": 7}]
