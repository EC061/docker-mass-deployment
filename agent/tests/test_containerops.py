from types import SimpleNamespace

import pytest

from lab_agent import containerops
from lab_agent.config import AgentConfig


def cfg():
    return AgentConfig(controller_url="ws://x", token="t", node_name="n")


def healthy(gpu=True, cdi=True):
    return SimpleNamespace(
        runtime=SimpleNamespace(docker_ok=True, userns_ok=True, nested_userns_ok=True),
        health=SimpleNamespace(status="healthy"),
        nvidia_gpu=gpu, nvidia_cdi=cdi,
    )


def common(monkeypatch, caps=None):
    monkeypatch.setattr(containerops.zfs, "get_mountpoint", lambda ds: "/fast/bio")
    monkeypatch.setattr(containerops.coldstore, "lab_mount", lambda c, lab: "/cold/bio")
    monkeypatch.setattr(containerops.usagereport, "ensure_labquota_dirs",
                        lambda c, lab: "/run/agent/labquota/bio")
    monkeypatch.setattr(containerops, "detect_capabilities", lambda c, deep=False: caps or healthy())
    monkeypatch.setattr(containerops.maintenance_state, "mark_unpatched", lambda c, lab: None)
    monkeypatch.setattr(containerops.docker, "wait_ssh_ready", lambda name: True)
    monkeypatch.setattr(containerops.docker, "ensure_image", lambda image: None)


def test_mount_contract(monkeypatch):
    common(monkeypatch)
    mounts = containerops._mounts(cfg(), "bio")
    assert mounts.fast == "/fast/bio"
    assert mounts.cold == "/cold/bio"
    assert mounts.labquota == "/run/agent/labquota/bio"
    assert mounts.apparmor_profile == "lab-codex"


def test_creation_requires_userns_and_passes_cdi(monkeypatch):
    common(monkeypatch)
    events = []
    monkeypatch.setattr(containerops.docker, "ensure_image", lambda image: events.append("pull"))
    monkeypatch.setattr(containerops.docker, "remove_container", lambda name: events.append("remove"))
    monkeypatch.setattr(containerops.docker, "create_container",
                        lambda *a, gpus, **kw: events.append(gpus) or "cid")
    assert containerops.ensure_container(cfg(), "bio", {}) == "cid"
    assert events == ["pull", "remove", True]

    common(monkeypatch, SimpleNamespace(
        runtime=SimpleNamespace(docker_ok=True, userns_ok=False, nested_userns_ok=True),
        health=SimpleNamespace(status="critical"),
        nvidia_gpu=False, nvidia_cdi=False,
    ))
    with pytest.raises(containerops.docker.DockerError, match="unhealthy"):
        containerops.ensure_container(cfg(), "bio", {})


def test_gpu_requires_nvml_and_cdi(monkeypatch):
    common(monkeypatch, healthy(gpu=True, cdi=False))
    got = {}
    monkeypatch.setattr(containerops.docker, "remove_container", lambda name: None)
    monkeypatch.setattr(containerops.docker, "create_container",
                        lambda *a, gpus, **kw: got.setdefault("gpus", gpus) or "cid")
    containerops.ensure_container(cfg(), "bio", {})
    assert got["gpus"] is False


def test_creation_removes_container_and_reports_logs_when_ssh_fails(monkeypatch):
    common(monkeypatch)
    removed = []
    monkeypatch.setattr(containerops.docker, "remove_container", removed.append)
    monkeypatch.setattr(containerops.docker, "create_container", lambda *a, **kw: "cid")
    monkeypatch.setattr(containerops.docker, "wait_ssh_ready", lambda name: False)
    monkeypatch.setattr(containerops.docker, "container_logs", lambda name: "sshd failed")

    with pytest.raises(containerops.docker.DockerError, match="sshd failed"):
        containerops.ensure_container(cfg(), "bio", {})

    assert removed == ["lab-bio", "lab-bio"]
