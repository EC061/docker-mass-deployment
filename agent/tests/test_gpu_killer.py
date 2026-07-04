from lab_agent.gpu.killer import GpuKiller, lab_from_container
from lab_agent.gpu.policy import GpuPolicy

_DERIVE = object()


def _proc(pid, util, vram=1 << 30, user="alice", container="lab-bio", managed=True, lab=_DERIVE):
    # A managed lab container carries the lab-agent.lab label; default it from the container name.
    return {
        "pid": pid, "util": util, "vram_bytes": vram, "user": user, "container": container,
        "managed": managed, "lab": lab_from_container(container) if lab is _DERIVE else lab,
    }


def test_lab_from_container():
    assert lab_from_container("lab-bio") == "bio"
    assert lab_from_container("/lab-bio") is None
    assert lab_from_container(None) is None


def test_warn_then_kill_after_grace():
    pol = GpuPolicy(enabled=True, util_threshold=5, idle_minutes=20, grace_minutes=10, interval_s=30)
    k = GpuKiller()
    procs = [_proc(100, util=0)]

    # t=0: idle starts, no decision yet.
    assert k.evaluate(procs, pol, now=0) == []
    # t=10min: still within idle window.
    assert k.evaluate(procs, pol, now=600) == []
    # t=20min: warn, having been idle the full 20 minutes.
    d = k.evaluate(procs, pol, now=1200)
    assert len(d) == 1 and d[0].action == "warn" and d[0].pid == 100 and d[0].user == "alice"
    assert d[0].idle_s == 1200
    # t=25min: within grace, no further decision.
    assert k.evaluate(procs, pol, now=1500) == []
    # t=30min: grace elapsed -> kill, idle_s covering the whole idle span.
    d = k.evaluate(procs, pol, now=1800)
    assert len(d) == 1 and d[0].action == "kill" and d[0].lab == "bio"
    assert d[0].idle_s == 1800


def test_active_process_resets_timer():
    pol = GpuPolicy(enabled=True, util_threshold=5, idle_minutes=20, grace_minutes=10)
    k = GpuKiller()
    assert k.evaluate([_proc(1, util=0)], pol, now=0) == []
    # Becomes busy at t=10min -> idle timer cleared.
    assert k.evaluate([_proc(1, util=80)], pol, now=600) == []
    # Idle again, first observed at t=12min -> idle_since resets to 720.
    assert k.evaluate([_proc(1, util=0)], pol, now=720) == []
    # t=30min: only 18min idle (since 720) -> still no warn (proves the reset).
    assert k.evaluate([_proc(1, util=0)], pol, now=1800) == []
    # t=32min: 20min idle since 720 -> warn.
    d = k.evaluate([_proc(1, util=0)], pol, now=1920)
    assert d and d[0].action == "warn"


def test_whitelist_user_and_lab_exempt():
    pol = GpuPolicy(enabled=True, util_threshold=5, idle_minutes=1, grace_minutes=1,
                    whitelist_users={"alice"})
    k = GpuKiller()
    assert k.evaluate([_proc(1, util=0, user="alice")], pol, now=0) == []
    assert k.evaluate([_proc(1, util=0, user="alice")], pol, now=10_000) == []

    pol2 = GpuPolicy(enabled=True, util_threshold=5, idle_minutes=1, grace_minutes=1,
                     whitelist_labs={"bio"})
    k2 = GpuKiller()
    assert k2.evaluate([_proc(2, util=0, container="lab-bio")], pol2, now=0) == []
    assert k2.evaluate([_proc(2, util=0, container="lab-bio")], pol2, now=10_000) == []


def test_immediate_kills_without_grace():
    pol = GpuPolicy(enabled=True, util_threshold=5, idle_minutes=20, grace_minutes=10, immediate=True)
    k = GpuKiller()
    d = k.evaluate([_proc(7, util=1)], pol, now=0)
    assert len(d) == 1 and d[0].action == "kill"


def test_host_process_is_never_touched():
    """A GPU process not in any container (managed=False, container=None) must never be warned/killed,
    even under an immediate-kill policy — the killer may only act on managed lab containers."""
    pol = GpuPolicy(enabled=True, util_threshold=5, idle_minutes=1, grace_minutes=1, immediate=True)
    k = GpuKiller()
    assert k.evaluate([_proc(1, util=0, container=None, managed=False)], pol, now=10_000) == []


def test_unmanaged_container_is_never_touched():
    """A container without the lab-agent.managed label (someone's own `docker run`, or a system
    container) is off-limits regardless of idleness."""
    pol = GpuPolicy(enabled=True, util_threshold=5, idle_minutes=1, grace_minutes=1, immediate=True)
    k = GpuKiller()
    procs = [_proc(2, util=0, container="someones-own", managed=False, lab=None)]
    assert k.evaluate(procs, pol, now=0) == []
    assert k.evaluate(procs, pol, now=10_000) == []


def test_disabled_policy_does_nothing():
    pol = GpuPolicy(enabled=False)
    k = GpuKiller()
    assert k.evaluate([_proc(1, util=0)], pol, now=10_000) == []


def test_unknown_util_not_killed():
    pol = GpuPolicy(enabled=True, util_threshold=5, idle_minutes=1, grace_minutes=1, immediate=True)
    k = GpuKiller()
    # util None -> treated as active, never killed.
    assert k.evaluate([_proc(1, util=None)], pol, now=10_000) == []


def test_policy_from_dict():
    pol = GpuPolicy.from_dict({
        "enabled": True, "util_threshold": 10, "idle_minutes": 5, "grace_minutes": 2,
        "whitelist_users": ["bob"], "whitelist_labs": ["chem"], "immediate": False,
    })
    assert pol.enabled and pol.util_threshold == 10 and pol.idle_minutes == 5
    assert pol.whitelist_users == {"bob"} and pol.whitelist_labs == {"chem"}
