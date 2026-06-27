import os

from lab_agent import system
from lab_agent.config import AgentConfig
from lab_agent.executors.base import CommandResult


def _cfg(**kw):
    base = dict(controller_url="ws://x", token="t", node_name="n", fast_pool="fast", slow_pool="slow")
    base.update(kw)
    return AgentConfig(**base)


class FakeRunner:
    """Returns canned CommandResults keyed by a prefix of the joined command."""

    def __init__(self, responses=None, default_ok=True):
        self.responses = responses or {}
        self.default_ok = default_ok
        self.calls: list[list[str]] = []

    def __call__(self, args, **kwargs):
        argv = [str(a) for a in args]
        self.calls.append(argv)
        joined = " ".join(argv)
        for prefix, res in self.responses.items():
            if joined.startswith(prefix):
                return res
        return CommandResult(self.default_ok, argv, 0 if self.default_ok else 1, "", "")


def _ok(stdout=""):
    return CommandResult(True, [], 0, stdout, "")


def _fail(stderr="err"):
    return CommandResult(False, [], 1, "", stderr)


def test_healthy_zfs_node(monkeypatch):
    runner = FakeRunner({
        "zfs version": _ok("zfs-2.2.0"),
        "docker version": _ok("24.0"),
        "docker info --format {{.Driver}}": _ok("zfs"),
        "docker info --format {{.Runtimes}}": _ok("map[nvidia:... runc:... sysbox-runc:...]"),
        "nvidia-smi -L": _ok("GPU 0: NVIDIA A100\nGPU 1: NVIDIA A100\n"),
        "zpool list -H -o name fast": _ok("fast"),
        "zpool list -H -o name slow": _ok("slow"),
    })
    monkeypatch.setattr(system, "run", runner)
    # A healthy GPU node also has Sysbox registered and an NVIDIA CDI spec generated.
    monkeypatch.setattr(system, "_cdi_present", lambda: True)
    caps = system.detect_capabilities(_cfg())
    assert caps.zfs is True
    assert caps.docker is True
    assert caps.docker_zfs_driver is True
    assert caps.nvidia_runtime is True
    assert caps.nvidia_gpu is True
    assert caps.gpu_count == 2
    assert caps.sysbox is True
    assert caps.nvidia_cdi is True
    assert caps.fast_pool_present is True
    assert caps.slow_pool_present is True
    assert caps.slow_backend == "zfs"
    assert caps.issues == []


def test_missing_sysbox_and_cdi_are_flagged(monkeypatch):
    runner = FakeRunner({
        "zfs version": _ok(),
        "docker version": _ok("24.0"),
        "docker info --format {{.Driver}}": _ok("zfs"),
        "docker info --format {{.Runtimes}}": _ok("map[runc:...]"),  # no sysbox-runc
        "nvidia-smi -L": _ok("GPU 0: NVIDIA A100\n"),
        "zpool list -H -o name fast": _ok("fast"),
        "zpool list -H -o name slow": _ok("slow"),
    })
    monkeypatch.setattr(system, "run", runner)
    monkeypatch.setattr(system, "_cdi_present", lambda: False)
    caps = system.detect_capabilities(_cfg())
    assert caps.sysbox is False
    assert caps.nvidia_cdi is False
    assert any("sysbox-runc runtime not found" in i for i in caps.issues)
    assert any("no CDI spec" in i for i in caps.issues)


def test_missing_zfs_records_issue_and_skips_pool_checks(monkeypatch):
    runner = FakeRunner({
        "zfs version": _fail(),
        "docker version": _ok("24.0"),
        "docker info --format {{.Driver}}": _ok("zfs"),
        "docker info --format {{.Runtimes}}": _ok("runc"),
        "nvidia-smi -L": _fail(),
    })
    monkeypatch.setattr(system, "run", runner)
    caps = system.detect_capabilities(_cfg())
    assert caps.zfs is False
    assert caps.fast_pool_present is False
    assert caps.slow_pool_present is False
    assert "zfs command not found" in caps.issues


def test_wrong_docker_storage_driver_is_flagged(monkeypatch):
    runner = FakeRunner({
        "zfs version": _ok(),
        "docker version": _ok(),
        "docker info --format {{.Driver}}": _ok("overlay2"),
        "docker info --format {{.Runtimes}}": _ok("runc"),
        "nvidia-smi -L": _fail(),
        "zpool list -H -o name fast": _ok("fast"),
        "zpool list -H -o name slow": _ok("slow"),
    })
    monkeypatch.setattr(system, "run", runner)
    caps = system.detect_capabilities(_cfg())
    assert caps.docker_zfs_driver is False
    assert any("storage driver is 'overlay2'" in i for i in caps.issues)


def test_missing_fast_pool_is_flagged(monkeypatch):
    runner = FakeRunner({
        "zfs version": _ok(),
        "docker version": _fail(),
        "nvidia-smi -L": _fail(),
        "zpool list -H -o name fast": _fail(),
        "zpool list -H -o name slow": _ok("slow"),
    })
    monkeypatch.setattr(system, "run", runner)
    caps = system.detect_capabilities(_cfg())
    assert caps.fast_pool_present is False
    assert any("fast pool 'fast' not found" in i for i in caps.issues)
    assert "docker not reachable" in caps.issues


def test_docker_unreachable_skips_driver_and_runtime(monkeypatch):
    runner = FakeRunner({
        "zfs version": _ok(),
        "docker version": _fail(),
        "nvidia-smi -L": _fail(),
        "zpool list -H -o name fast": _ok("fast"),
        "zpool list -H -o name slow": _ok("slow"),
    })
    monkeypatch.setattr(system, "run", runner)
    caps = system.detect_capabilities(_cfg())
    assert caps.docker is False
    assert caps.docker_zfs_driver is False
    assert caps.nvidia_runtime is False


def test_smb_backend_checks_mountpoint_not_pool(monkeypatch):
    runner = FakeRunner({
        "zfs version": _ok(),
        "docker version": _ok(),
        "docker info --format {{.Driver}}": _ok("zfs"),
        "docker info --format {{.Runtimes}}": _ok("nvidia"),
        "nvidia-smi -L": _ok("GPU 0: X\n"),
        "zpool list -H -o name fast": _ok("fast"),
    })
    monkeypatch.setattr(system, "run", runner)
    monkeypatch.setattr(os.path, "ismount", lambda p: True)
    cfg = _cfg(slow_backend="smb", slow_path="/mnt/cold", slow_shared=True)
    caps = system.detect_capabilities(cfg)
    assert caps.slow_backend == "smb"
    assert caps.slow_shared is True
    assert caps.slow_pool_present is True
    # The slow pool name must never be probed on the SMB backend.
    assert ["zpool", "list", "-H", "-o", "name", "slow"] not in runner.calls


def test_smb_backend_unmounted_is_flagged(monkeypatch):
    runner = FakeRunner({
        "zfs version": _ok(),
        "docker version": _fail(),
        "nvidia-smi -L": _fail(),
        "zpool list -H -o name fast": _ok("fast"),
    })
    monkeypatch.setattr(system, "run", runner)
    monkeypatch.setattr(os.path, "ismount", lambda p: False)
    cfg = _cfg(slow_backend="smb", slow_path="/mnt/cold")
    caps = system.detect_capabilities(cfg)
    assert caps.slow_pool_present is False
    assert any("SMB mount '/mnt/cold' is not mounted" in i for i in caps.issues)


def test_to_dict_roundtrips_fields():
    caps = system.Capabilities(
        zfs=True, docker=True, docker_zfs_driver=True, nvidia_runtime=False,
        nvidia_gpu=False, gpu_count=0, sysbox=True, nvidia_cdi=False, fast_pool_present=True,
        slow_pool_present=True, slow_backend="zfs", slow_shared=False, issues=["x"],
    )
    d = caps.to_dict()
    assert d["zfs"] is True
    assert d["gpu_count"] == 0
    assert d["sysbox"] is True
    assert d["nvidia_cdi"] is False
    assert d["issues"] == ["x"]
