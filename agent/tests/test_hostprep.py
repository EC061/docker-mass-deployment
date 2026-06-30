import json
from importlib import resources

import pytest

from lab_agent.config import AgentConfig
from lab_agent.hostprep import (
    mapped_host_id,
    merge_daemon_config,
    replace_subid_entry,
    subid_conflicts,
)


def cfg():
    return AgentConfig(controller_url="ws://x", token="t")


def test_host_id_translation_and_bounds():
    assert mapped_host_id(cfg(), 0) == 231072
    assert mapped_host_id(cfg(), 10000) == 241072
    assert mapped_host_id(cfg(), 59999) == 291071
    with pytest.raises(ValueError):
        mapped_host_id(cfg(), 65536)


def test_subid_entry_is_exact_and_idempotent():
    before = "other:100000:65536\nlabdockremap:1:2\n"
    once = replace_subid_entry(before, "labdockremap", 231072, 65536)
    twice = replace_subid_entry(once, "labdockremap", 231072, 65536)
    assert once == twice
    assert once.count("labdockremap:") == 1
    assert "labdockremap:231072:65536" in once
    assert subid_conflicts("other:250000:1000\n", "labdockremap", 231072, 65536)
    assert not subid_conflicts("other:400000:1000\n", "labdockremap", 231072, 65536)


def test_daemon_config_preserves_unrelated_settings():
    merged = merge_daemon_config({"log-driver": "journald"}, cfg())
    assert merged == {
        "log-driver": "journald", "userns-remap": "labdockremap", "data-root": "/var/lib/docker"
    }


def test_security_assets_include_required_bubblewrap_syscalls():
    root = resources.files("lab_agent").joinpath("assets")
    profile = json.loads(root.joinpath("lab-codex-seccomp.json").read_text())
    allowed = {name for group in profile["syscalls"] if group["action"] == "SCMP_ACT_ALLOW"
               for name in group["names"]}
    assert {"clone", "clone3", "unshare", "setns", "mount", "umount2", "pivot_root",
            "fsopen", "fsconfig", "fsmount", "move_mount", "open_tree", "mount_setattr",
            "seccomp", "prctl", "capset"} <= allowed
    apparmor = root.joinpath("lab-codex.apparmor").read_text()
    assert "/usr/bin/bwrap cx -> lab-codex-bwrap" in apparmor
    assert "profile lab-codex-bwrap" in apparmor and "userns," in apparmor
