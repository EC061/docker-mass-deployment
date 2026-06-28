from types import SimpleNamespace

from lab_agent import telemetry
from lab_agent.config import AgentConfig
from lab_agent.executors.base import CommandResult


def _cfg(**kw):
    base = dict(controller_url="ws://x", token="t", node_name="n", fast_pool="fast", slow_pool="slow")
    base.update(kw)
    return AgentConfig(**base)


def test_pool_free_parses_zpool_output(monkeypatch):
    monkeypatch.setattr(
        telemetry, "run",
        lambda args, **kw: CommandResult(True, [], 0, "fast\t1000\t400\t600\n", ""),
    )
    info = telemetry._pool_free("fast")
    assert info == {"name": "fast", "size": 1000, "alloc": 400, "free": 600}


def test_pool_free_none_on_command_failure(monkeypatch):
    monkeypatch.setattr(telemetry, "run", lambda args, **kw: CommandResult(False, [], 1, "", "no pool"))
    assert telemetry._pool_free("gone") is None


def test_pool_free_none_on_empty_output(monkeypatch):
    monkeypatch.setattr(telemetry, "run", lambda args, **kw: CommandResult(True, [], 0, "  \n", ""))
    assert telemetry._pool_free("fast") is None


def test_pool_free_none_on_short_output(monkeypatch):
    monkeypatch.setattr(telemetry, "run", lambda args, **kw: CommandResult(True, [], 0, "fast 1 2\n", ""))
    assert telemetry._pool_free("fast") is None


def test_pools_excludes_slow_on_smb_backend(monkeypatch):
    seen: list[str] = []

    def fake_run(args, **kw):
        pool = str(args[-1])
        seen.append(pool)
        return CommandResult(True, [], 0, f"{pool}\t10\t1\t9\n", "")

    monkeypatch.setattr(telemetry, "run", fake_run)
    cfg = _cfg(slow_backend="smb", slow_path="/mnt/cold")
    pools = telemetry._pools(cfg)
    assert [p["name"] for p in pools] == ["fast"]
    assert seen == ["fast"]


def test_pools_includes_both_on_zfs_backend(monkeypatch):
    monkeypatch.setattr(
        telemetry, "run",
        lambda args, **kw: CommandResult(True, [], 0, f"{args[-1]}\t10\t1\t9\n", ""),
    )
    pools = telemetry._pools(_cfg())
    assert {p["name"] for p in pools} == {"fast", "slow"}


def test_pools_drops_unavailable_pool(monkeypatch):
    def fake_run(args, **kw):
        pool = str(args[-1])
        if pool == "slow":
            return CommandResult(False, [], 1, "", "missing")
        return CommandResult(True, [], 0, f"{pool}\t10\t1\t9\n", "")

    monkeypatch.setattr(telemetry, "run", fake_run)
    pools = telemetry._pools(_cfg())
    assert [p["name"] for p in pools] == ["fast"]


def test_collect_heartbeat_assembles_all_sections(monkeypatch):
    cfg = _cfg()
    monkeypatch.setattr(
        telemetry, "run",
        lambda args, **kw: CommandResult(True, [], 0, f"{args[-1]}\t10\t1\t9\n", ""),
    )
    monkeypatch.setattr(telemetry.zfs, "list_usage", lambda root: [
        SimpleNamespace(dataset="fast/labs/bio", used_bytes=100, quota_bytes=200, available_bytes=100),
    ])
    monkeypatch.setattr(telemetry.coldstore, "list_usage", lambda cfg: [
        {"pool": "slow", "dataset": "slow/labs/bio", "used_bytes": 5, "quota_bytes": None,
         "available_bytes": None},
    ])
    monkeypatch.setattr(telemetry.zfs, "scrub_status",
                        lambda p: SimpleNamespace(to_dict=lambda: {"pool": p, "healthy": True}))
    monkeypatch.setattr(telemetry, "list_gpu_processes", lambda: [{"pid": 1, "vram_bytes": 1024}])

    hb = telemetry.collect_heartbeat(cfg)
    assert {p["name"] for p in hb["pools"]} == {"fast", "slow"}
    datasets = {d["dataset"] for d in hb["datasets"]}
    assert datasets == {"fast/labs/bio", "slow/labs/bio"}
    assert {s["pool"] for s in hb["scrub"]} == {"fast", "slow"}
    assert hb["gpu_processes"] == [{"pid": 1, "vram_bytes": 1024}]
    # No scan cache passed -> no per-student du rows, no scan timestamps.
    assert hb["usage_scans"] == []


def test_collect_heartbeat_includes_scan_breakdown(monkeypatch):
    """A populated scan cache contributes per-student docker/fast/slow rows + a scan timestamp."""
    from lab_agent import usagereport

    cfg = _cfg()
    monkeypatch.setattr(telemetry, "run",
                        lambda args, **kw: CommandResult(True, [], 0, f"{args[-1]}\t10\t1\t9\n", ""))
    monkeypatch.setattr(telemetry.zfs, "list_usage", lambda root: [])
    monkeypatch.setattr(telemetry.coldstore, "list_usage", lambda cfg: [])
    monkeypatch.setattr(telemetry.zfs, "scrub_status",
                        lambda p: SimpleNamespace(to_dict=lambda: {"pool": p}))
    monkeypatch.setattr(telemetry, "list_gpu_processes", lambda: [])

    state = usagereport.UsageState()
    state.set_docker("bio", usagereport.DockerUsage(
        scanned_at=777, total_used=300, per_user={"alice": 120},
        per_user_fast={"alice": 40}, per_user_slow={"alice": 10},
    ))

    hb = telemetry.collect_heartbeat(cfg, state)
    rows = {(d["pool"], d["dataset"]): d["used_bytes"] for d in hb["datasets"]}
    assert rows[("docker", "docker/labs/bio")] == 300
    assert rows[("docker", "docker/labs/bio/users/alice")] == 120
    assert rows[("fast", "fast/labs/bio/users/alice")] == 40
    assert rows[("slow", "slow/labs/bio/users/alice")] == 10
    assert hb["usage_scans"] == [{"lab": "bio", "scanned_at": 777}]
