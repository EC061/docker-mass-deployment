from types import SimpleNamespace

from lab_agent import containerops
from lab_agent.config import AgentConfig


def _cfg():
    return AgentConfig(controller_url="ws://x", token="t", node_name="n")


def _patch_common(monkeypatch, *, nvidia_runtime=True, nvidia_gpu=True):
    monkeypatch.setattr(containerops.zfs, "get_mountpoint",
                        lambda ds: f"/mnt/{ds.replace('/', '_')}")
    monkeypatch.setattr(containerops.coldstore, "shared_mount", lambda cfg, lab: f"/cold/{lab}/shared")
    monkeypatch.setattr(containerops.coldstore, "users_mount", lambda cfg, lab: f"/cold/{lab}/users")
    monkeypatch.setattr(containerops, "detect_capabilities",
                        lambda cfg: SimpleNamespace(nvidia_runtime=nvidia_runtime, nvidia_gpu=nvidia_gpu))


def test_mounts_built_from_paths_and_coldstore(monkeypatch):
    _patch_common(monkeypatch)
    mounts = containerops._mounts(_cfg(), "bio")
    assert mounts.fast_shared == "/mnt/fast_labs_bio_shared"
    assert mounts.fast_users == "/mnt/fast_labs_bio_users"
    assert mounts.slow_shared == "/cold/bio/shared"
    assert mounts.slow_users == "/cold/bio/users"


def test_ensure_container_removes_old_then_creates(monkeypatch):
    _patch_common(monkeypatch)
    events = []
    monkeypatch.setattr(containerops.docker, "remove_container",
                        lambda name: events.append(("remove", name)))

    def fake_create(name, opts, mounts, *, gpus):
        events.append(("create", name, gpus))
        return "cid123"

    monkeypatch.setattr(containerops.docker, "create_container", fake_create)

    cid = containerops.ensure_container(_cfg(), "bio", {"image": "custom-ssh"})
    assert cid == "cid123"
    # Remove must happen before create.
    assert events == [("remove", "lab-bio"), ("create", "lab-bio", True)]


def test_ensure_container_disables_gpus_without_runtime(monkeypatch):
    _patch_common(monkeypatch, nvidia_runtime=False, nvidia_gpu=True)
    captured = {}
    monkeypatch.setattr(containerops.docker, "remove_container", lambda name: None)
    monkeypatch.setattr(containerops.docker, "create_container",
                        lambda name, opts, mounts, *, gpus: captured.update(gpus=gpus) or "id")
    containerops.ensure_container(_cfg(), "bio", {})
    assert captured["gpus"] is False


def test_ensure_container_passes_options_from_params(monkeypatch):
    _patch_common(monkeypatch)
    captured = {}
    monkeypatch.setattr(containerops.docker, "remove_container", lambda name: None)

    def fake_create(name, opts, mounts, *, gpus):
        captured["opts"] = opts
        captured["mounts"] = mounts
        return "id"

    monkeypatch.setattr(containerops.docker, "create_container", fake_create)
    containerops.ensure_container(_cfg(), "bio", {"image": "myimg", "ssh_port": 2222})
    assert captured["opts"].image == "myimg"
    assert captured["opts"].ssh_port == 2222
    assert captured["mounts"].slow_users == "/cold/bio/users"


def test_recreate_container_handler_returns_result_and_log(monkeypatch):
    _patch_common(monkeypatch)
    monkeypatch.setattr(containerops.docker, "remove_container", lambda name: None)
    monkeypatch.setattr(containerops.docker, "create_container",
                        lambda name, opts, mounts, *, gpus: "cid999")
    result, log = containerops.recreate_container(_cfg(), {"lab": "bio"})
    assert result == {"lab": "bio", "container": "cid999"}
    assert "recreated container for lab 'bio'" in log
