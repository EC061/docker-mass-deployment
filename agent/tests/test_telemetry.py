from types import SimpleNamespace

from storagehelp import make_cfg

from lab_agent import telemetry, usagereport
from lab_agent.executors.zfs import MountState, PoolCapacity


def cfg(**kw):
    kw.setdefault("node_name", "n")
    return make_cfg(**kw)


def _pools(monkeypatch, capacities: dict[str, tuple[int, int, str]]):
    monkeypatch.setattr(
        telemetry.zfs, "pool_capacity",
        lambda p: (PoolCapacity(p, capacities[p][0], capacities[p][0] - capacities[p][1],
                                capacities[p][1], capacities[p][2]) if p in capacities else None),
    )


def _tiers(monkeypatch, usable: set[str]):
    monkeypatch.setattr(
        telemetry.service.zfs, "pool_capacity",
        lambda p: PoolCapacity(p, 100, 40, 60, "ONLINE") if p in usable else None,
    )
    monkeypatch.setattr(
        telemetry.service.zfs, "mount_state",
        lambda ds, expected=None: MountState(
            ds, ds.split("/")[0] in usable, ds.split("/")[0] in usable,
            expected if ds.split("/")[0] in usable else None, expected,
        ),
    )


def test_pool_telemetry_is_tagged_with_its_tier(monkeypatch):
    _pools(monkeypatch, {"fast": (100, 60, "ONLINE"), "slow": (200, 150, "ONLINE")})
    rows = telemetry._pools(cfg())
    assert [(r["name"], r["free"], r["tiers"]) for r in rows] == [
        ("fast", 60, ["fast", "docker"]),
        ("slow", 150, ["cold"]),
    ]


def test_smb_node_reports_no_cold_pool(monkeypatch):
    _pools(monkeypatch, {"fast": (100, 60, "ONLINE")})
    assert [p["name"] for p in telemetry._pools(cfg(cold_backend="smb"))] == ["fast"]


def test_every_pool_of_a_multi_pool_tier_is_reported_independently(monkeypatch):
    _pools(monkeypatch, {
        "fast1": (100, 60, "ONLINE"), "fast2": (100, 10, "ONLINE"),
        "cold1": (400, 300, "ONLINE"), "cold2": (400, 0, "DEGRADED"),
    })
    rows = telemetry._pools(cfg(fast_pools=["fast1", "fast2"], cold_pools=["cold1", "cold2"],
                                docker_pool="fast1"))
    assert [(r["name"], r["health"]) for r in rows] == [
        ("fast1", "ONLINE"), ("fast2", "ONLINE"), ("cold1", "ONLINE"), ("cold2", "DEGRADED"),
    ]
    # The controller can tell exactly which pool backs which tier, without guessing by position.
    assert {r["name"]: r["tiers"] for r in rows}["cold2"] == ["cold"]
    assert {r["name"]: r["tiers"] for r in rows}["fast1"] == ["fast", "docker"]


def test_a_missing_pool_is_reported_rather_than_omitted(monkeypatch):
    _pools(monkeypatch, {"fast1": (100, 60, "ONLINE")})
    rows = telemetry._pools(cfg(fast_pools=["fast1", "fast2"], docker_pool="fast1"))
    missing = next(r for r in rows if r["name"] == "fast2")
    assert missing["imported"] is False and missing["health"] == "UNAVAIL"


def test_tier_summary_reports_degraded_with_the_broken_pool(monkeypatch):
    _tiers(monkeypatch, {"cold1", "fast1", "fast2"})
    summaries = {
        s["tier"]: s
        for s in telemetry.service.tier_summaries(
            cfg(fast_pools=["fast1", "fast2"], cold_pools=["cold1", "cold2"], docker_pool="fast1")
        )
    }
    assert summaries["fast"]["health"] == "healthy"
    assert summaries["cold"]["health"] == "degraded"
    assert summaries["cold"]["unavailable_pools"] == ["cold2"]


def test_heartbeat_uses_explicit_storage_rows(monkeypatch):
    _pools(monkeypatch, {"fast": (100, 60, "ONLINE"), "slow": (200, 150, "ONLINE")})
    _tiers(monkeypatch, {"fast", "slow"})
    monkeypatch.setattr(telemetry.zfs, "scrub_status",
                        lambda p: SimpleNamespace(to_dict=lambda: {"pool": p}))
    monkeypatch.setattr(telemetry, "list_gpu_processes", lambda: [])
    monkeypatch.setattr(telemetry.coldstore, "cold_status",
                        lambda c: {"backend": "zfs", "ready": True})
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
    assert ("rootfs", "alice") not in rows
    assert rows[("fast", "alice")] == 4
    assert rows[("cold", "alice")] == 1
    assert "datasets" not in hb
    assert hb["usage_scans"] == [{"lab": "bio", "scanned_at": 7}]
    assert [t["tier"] for t in hb["storage_tiers"]] == ["fast", "cold"]


def test_heartbeat_reports_one_lab_row_per_tier_not_one_per_branch(monkeypatch):
    """A lab on two fast pools must still produce exactly ONE fast row: no double counting."""
    _pools(monkeypatch, {"fast1": (100, 60, "ONLINE"), "fast2": (100, 60, "ONLINE"),
                         "slow": (200, 150, "ONLINE")})
    _tiers(monkeypatch, {"fast1", "fast2", "slow"})
    monkeypatch.setattr(telemetry.zfs, "scrub_status",
                        lambda p: SimpleNamespace(to_dict=lambda: {"pool": p}))
    monkeypatch.setattr(telemetry, "list_gpu_processes", lambda: [])
    monkeypatch.setattr(telemetry.coldstore, "cold_status",
                        lambda c: {"backend": "zfs", "ready": True})
    state = usagereport.UsageState()
    # The lab-usage cache already holds ONE aggregated row per tier (see usagereport).
    state.set_lab_level("bio", usagereport.LabLevelUsage(computed_at=1, storage=[
        {"lab": "bio", "user": None, "tier": "fast", "used_bytes": 400,
         "quota_bytes": 1000, "available_bytes": 600},
        {"lab": "bio", "user": None, "tier": "cold", "used_bytes": 10,
         "quota_bytes": 50, "available_bytes": 40},
    ]))
    hb = telemetry.collect_heartbeat(
        cfg(fast_pools=["fast1", "fast2"], docker_pool="fast1"), state
    )
    fast_rows = [r for r in hb["storage"] if r["tier"] == "fast" and r["user"] is None]
    assert len(fast_rows) == 1
    assert fast_rows[0]["used_bytes"] == 400
