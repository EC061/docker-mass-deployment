from types import SimpleNamespace

from lab_agent import containerops
from lab_agent.config import AgentConfig


def _cfg():
    return AgentConfig(controller_url="ws://x", token="t", node_name="n")


def _patch_common(monkeypatch, *, nvidia_runtime=True, nvidia_gpu=True, nvidia_cdi=True):
    monkeypatch.setattr(containerops.zfs, "get_mountpoint",
                        lambda ds: f"/mnt/{ds.replace('/', '_')}")
    monkeypatch.setattr(containerops.coldstore, "shared_mount", lambda cfg, lab: f"/cold/{lab}/shared")
    monkeypatch.setattr(containerops.coldstore, "users_mount", lambda cfg, lab: f"/cold/{lab}/users")
    # _mounts ensures the root-owned labquota status dir on the host; stub the real mkdir in tests.
    monkeypatch.setattr(containerops.usagereport, "ensure_labquota_dirs", lambda cfg, lab: f"/lq/{lab}")
    monkeypatch.setattr(containerops, "detect_capabilities",
                        lambda cfg: SimpleNamespace(nvidia_runtime=nvidia_runtime,
                                                    nvidia_gpu=nvidia_gpu, nvidia_cdi=nvidia_cdi))
    # Recreate resets the lab's apt-upgrade record; stub the on-disk write in unit tests.
    monkeypatch.setattr(containerops.maintenance_state, "mark_unpatched", lambda cfg, lab: None)


def test_mounts_built_from_paths_and_coldstore(monkeypatch):
    _patch_common(monkeypatch)
    mounts = containerops._mounts(_cfg(), "bio")
    assert mounts.fast_shared == "/mnt/fast_labs_bio_shared"
    assert mounts.fast_users == "/mnt/fast_labs_bio_users"
    assert mounts.slow_shared == "/cold/bio/shared"
    assert mounts.slow_users == "/cold/bio/users"
    assert mounts.labquota == "/lq/bio"


def test_ensure_container_removes_old_then_creates(monkeypatch):
    _patch_common(monkeypatch)
    events = []
    monkeypatch.setattr(containerops.docker, "remove_container",
                        lambda name: events.append(("remove", name)))

    def fake_create(name, opts, mounts, *, gpus, labels=None):
        events.append(("create", name, gpus))
        return "cid123"

    monkeypatch.setattr(containerops.docker, "create_container", fake_create)

    cid = containerops.ensure_container(_cfg(), "bio", {"image": "custom-ssh"})
    assert cid == "cid123"
    # Remove must happen before create.
    assert events == [("remove", "lab-bio"), ("create", "lab-bio", True)]


def test_ensure_container_disables_gpus_without_cdi(monkeypatch):
    # GPUs are attached via CDI under sysbox; without a CDI spec we launch GPU-less.
    _patch_common(monkeypatch, nvidia_gpu=True, nvidia_cdi=False)
    captured = {}
    monkeypatch.setattr(containerops.docker, "remove_container", lambda name: None)
    monkeypatch.setattr(containerops.docker, "create_container",
                        lambda name, opts, mounts, *, gpus, labels=None: captured.update(gpus=gpus) or "id")
    containerops.ensure_container(_cfg(), "bio", {})
    assert captured["gpus"] is False


def test_ensure_container_passes_options_from_params(monkeypatch):
    _patch_common(monkeypatch)
    captured = {}
    monkeypatch.setattr(containerops.docker, "remove_container", lambda name: None)

    def fake_create(name, opts, mounts, *, gpus, labels=None):
        captured["opts"] = opts
        captured["mounts"] = mounts
        return "id"

    monkeypatch.setattr(containerops.docker, "create_container", fake_create)
    containerops.ensure_container(_cfg(), "bio", {"image": "myimg", "ssh_port": 2222})
    assert captured["opts"].image == "myimg"
    assert captured["opts"].ssh_port == 2222
    assert captured["mounts"].slow_users == "/cold/bio/users"


def _fake_docker(monkeypatch, *, ready=True, image_ok=True):
    """A tiny in-memory docker stand-in tracking which containers exist + the call order."""
    state = {"containers": {"lab-bio"}, "events": []}
    ev = state["events"]
    d = containerops.docker

    def ensure_image(img):
        ev.append(("ensure_image", img))
        if not image_ok:
            raise d.DockerError("image unavailable")

    def remove_container(name):
        ev.append(("remove", name))
        state["containers"].discard(name)

    def rename_container(old, new):
        ev.append(("rename", old, new))
        state["containers"].discard(old)
        state["containers"].add(new)

    def create_container(name, opts, mounts, *, gpus, labels=None):
        ev.append(("create", name))
        state["containers"].add(name)
        return "cid999"

    monkeypatch.setattr(d, "ensure_image", ensure_image)
    monkeypatch.setattr(d, "container_exists", lambda name: name in state["containers"])
    monkeypatch.setattr(d, "stop_container", lambda name, **k: ev.append(("stop", name)))
    monkeypatch.setattr(d, "remove_container", remove_container)
    monkeypatch.setattr(d, "rename_container", rename_container)
    monkeypatch.setattr(d, "create_container", create_container)
    monkeypatch.setattr(d, "start_container", lambda name: ev.append(("start", name)))
    monkeypatch.setattr(d, "wait_systemd_ready", lambda name, **k: ready)
    return state


def test_recreate_promotes_candidate_after_readiness(monkeypatch):
    _patch_common(monkeypatch)
    state = _fake_docker(monkeypatch, ready=True)
    result, log = containerops.recreate_container(_cfg(), {"lab": "bio", "image": "custom-ssh"})
    assert result == {"lab": "bio", "container": "cid999"}
    assert "recreated container for lab 'bio'" in log
    kinds = [e[0] for e in state["events"]]
    # image checked before the old container is touched; old preserved (renamed) before candidate.
    assert kinds.index("ensure_image") < kinds.index("stop") < kinds.index("create")
    assert ("rename", "lab-bio", "lab-bio-old") in state["events"]
    # promoted: the preserved old container is removed and the real name remains.
    assert ("remove", "lab-bio-old") in state["events"]
    assert state["containers"] == {"lab-bio"}


def test_recreate_rolls_back_when_candidate_not_ready(monkeypatch):
    _patch_common(monkeypatch)
    state = _fake_docker(monkeypatch, ready=False)
    try:
        containerops.recreate_container(_cfg(), {"lab": "bio", "image": "custom-ssh"})
        raise AssertionError("expected rollback to raise")
    except containerops.docker.DockerError as e:
        assert "rolled back" in str(e)
    # candidate removed, old restored under the real name and restarted.
    assert ("rename", "lab-bio-old", "lab-bio") in state["events"]
    assert ("start", "lab-bio") in state["events"]
    assert state["containers"] == {"lab-bio"}


def test_recreate_fails_fast_without_touching_the_running_container(monkeypatch):
    _patch_common(monkeypatch)
    state = _fake_docker(monkeypatch, image_ok=False)
    try:
        containerops.recreate_container(_cfg(), {"lab": "bio", "image": "bad"})
        raise AssertionError("expected image check to raise")
    except containerops.docker.DockerError:
        pass
    # The working container was never stopped/renamed/removed.
    assert all(e[0] not in ("stop", "rename", "create", "remove") for e in state["events"])
    assert state["containers"] == {"lab-bio"}
