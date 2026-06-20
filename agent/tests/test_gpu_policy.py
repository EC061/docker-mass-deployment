import pytest

from lab_agent.config import AgentConfig
from lab_agent.gpu import policy as gpu_policy
from lab_agent.gpu.policy import GpuPolicy


@pytest.fixture(autouse=True)
def _restore_global():
    # set_policy mutates module-global state; restore it after each test.
    saved = gpu_policy._current
    yield
    gpu_policy._current = saved


def test_defaults_are_conservative():
    p = GpuPolicy()
    assert p.enabled is False
    assert p.util_threshold == 5.0
    assert p.idle_minutes == 20.0
    assert p.grace_minutes == 10.0
    assert p.immediate is False
    assert p.interval_s == 30
    assert p.whitelist_users == set()
    assert p.whitelist_labs == set()


def test_from_dict_full():
    p = GpuPolicy.from_dict({
        "enabled": 1,
        "immediate": True,
        "util_threshold": "12.5",
        "idle_minutes": 5,
        "grace_minutes": 2,
        "interval_s": "60",
        "whitelist_users": ["root", "admin"],
        "whitelist_labs": ["bio"],
    })
    assert p.enabled is True
    assert p.immediate is True
    assert p.util_threshold == 12.5
    assert p.idle_minutes == 5.0
    assert p.grace_minutes == 2.0
    assert p.interval_s == 60
    assert p.whitelist_users == {"root", "admin"}
    assert p.whitelist_labs == {"bio"}


def test_from_dict_empty_keeps_defaults():
    p = GpuPolicy.from_dict({})
    assert p == GpuPolicy()


def test_from_dict_none_floats_ignored():
    p = GpuPolicy.from_dict({"util_threshold": None, "idle_minutes": None})
    assert p.util_threshold == 5.0
    assert p.idle_minutes == 20.0


def test_from_dict_zero_interval_falls_back_to_default():
    # interval_s uses truthiness, so 0 keeps the default.
    p = GpuPolicy.from_dict({"interval_s": 0})
    assert p.interval_s == 30


def test_from_dict_null_whitelists_become_empty_sets():
    p = GpuPolicy.from_dict({"whitelist_users": None, "whitelist_labs": None})
    assert p.whitelist_users == set()
    assert p.whitelist_labs == set()


def test_set_policy_updates_global_and_get_policy_reflects_it():
    p = gpu_policy.set_policy({"enabled": True, "idle_minutes": 7})
    assert p.enabled is True
    assert gpu_policy.get_policy() is p
    assert gpu_policy.get_policy().idle_minutes == 7.0


def test_update_policy_handler_sets_policy_and_returns_summary():
    cfg = AgentConfig(controller_url="ws://x", token="t")
    result, log = gpu_policy.update_policy_handler(cfg, {"enabled": True, "idle_minutes": 15})
    assert result == {"enabled": True, "idle_minutes": 15.0}
    assert "gpu policy updated" in log
    assert gpu_policy.get_policy().enabled is True
