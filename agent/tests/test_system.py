from lab_agent import system
from lab_agent.config import AgentConfig
from lab_agent.executors.base import CommandResult


def cfg(**kw):
    return AgentConfig(controller_url="ws://x", token="t", **kw)


class Runner:
    def __init__(self, responses):
        self.responses = responses

    def __call__(self, args, **kwargs):
        command = " ".join(str(x) for x in args)
        for prefix, value in self.responses.items():
            if command.startswith(prefix):
                ok, stdout = value
                return CommandResult(ok, list(args), 0 if ok else 1, stdout, "" if ok else "err")
        return CommandResult(False, list(args), 1, "", "err")


def healthy_runner():
    return Runner({
        "zfs version": (True, "zfs-2.2"),
        "docker version": (True, "27"),
        "docker info --format {{.Driver}}": (True, "zfs"),
        "docker info --format {{.DockerRootDir}}": (True, "/var/lib/docker"),
        "docker info --format {{json .SecurityOptions}}":
            (True, '["name=seccomp,profile=default","name=userns:user=labdockremap"]'),
        "sysctl -n kernel.unprivileged_userns_clone": (True, "1"),
        "sysctl -n user.max_user_namespaces": (True, "16384"),
        "nvidia-smi -L": (True, "GPU 0: A100"),
        "nvidia-smi --query-gpu=driver_version": (True, "570.1"),
        "nvidia-ctk cdi list": (True, "nvidia.com/gpu=all\nnvidia.com/gpu=0"),
        "zpool list -H -o name fast": (True, "fast"),
        "zpool list -H -o name slow": (True, "slow"),
        "zfs get -H -o value mounted fast/labs": (True, "yes"),
        "zfs get -H -o value mountpoint fast/labs": (True, "/fast"),
        "zfs get -H -o value mounted slow/labs": (True, "yes"),
        "zfs get -H -o value mountpoint slow/labs": (True, "/slow/labs"),
    })


def test_structured_healthy_capabilities(monkeypatch):
    monkeypatch.setattr(system, "run", healthy_runner())
    monkeypatch.setattr(system, "_security_profiles_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_subid_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_loaded_driver_version", lambda: "570.1")
    caps = system.detect_capabilities(cfg(), deep=False)
    assert caps.runtime.docker_ok and caps.runtime.userns_ok and caps.runtime.nested_userns_ok
    assert caps.nvidia.gpu_count == 1 and caps.nvidia.cdi_ok
    assert caps.health.status == "healthy"
    assert caps.to_dict()["runtime"]["userns_user"] == "labdockremap"


def test_userns_misconfiguration_blocks_health(monkeypatch):
    runner = healthy_runner()
    runner.responses["docker info --format {{json .SecurityOptions}}"] = (True, '["name=seccomp"]')
    monkeypatch.setattr(system, "run", runner)
    monkeypatch.setattr(system, "_security_profiles_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_subid_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_loaded_driver_version", lambda: "570.1")
    caps = system.detect_capabilities(cfg(), deep=False)
    assert caps.health.status == "critical"
    assert any(i.code == "docker_userns" and i.repairable for i in caps.issues)


def test_nvml_mismatch_requires_reboot(monkeypatch):
    runner = healthy_runner()
    runner.responses["nvidia-smi -L"] = (False, "")
    runner.responses["nvidia-smi --query-gpu=driver_version"] = (False, "")
    monkeypatch.setattr(system, "run", runner)
    monkeypatch.setattr(system, "_security_profiles_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_subid_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_loaded_driver_version", lambda: "570.1")
    caps = system.detect_capabilities(cfg(), deep=False)
    issue = next(i for i in caps.issues if i.code == "nvml_driver_mismatch")
    assert issue.severity == "critical" and issue.repairable is False


def test_missing_smb_mount_is_critical(monkeypatch):
    runner = healthy_runner()
    monkeypatch.setattr(system, "run", runner)
    monkeypatch.setattr(system, "_security_profiles_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_subid_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_loaded_driver_version", lambda: "")
    monkeypatch.setattr(system.os.path, "ismount", lambda path: False)
    caps = system.detect_capabilities(cfg(slow_backend="smb"), deep=False)
    assert any(i.code == "cold_storage_missing" for i in caps.issues)


def test_stale_cdi_and_namespace_failures_are_critical(monkeypatch):
    runner = healthy_runner()
    runner.responses["nvidia-ctk cdi list"] = (True, "nvidia.com/gpu=all")
    runner.responses["sysctl -n user.max_user_namespaces"] = (True, "1024")
    monkeypatch.setattr(system, "run", runner)
    monkeypatch.setattr(system, "_security_profiles_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_subid_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_loaded_driver_version", lambda: "570.1")
    caps = system.detect_capabilities(cfg(), deep=False)
    assert any(i.code == "nvidia_cdi_stale" and i.repairable for i in caps.issues)
    assert any(i.code == "bubblewrap_namespace" for i in caps.issues)


def test_driver_or_secure_boot_failure_is_operator_only(monkeypatch):
    runner = healthy_runner()
    runner.responses["nvidia-smi -L"] = (False, "")
    runner.responses["nvidia-smi --query-gpu=driver_version"] = (False, "")
    monkeypatch.setattr(system, "run", runner)
    monkeypatch.setattr(system, "_security_profiles_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_subid_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_loaded_driver_version", lambda: "")
    monkeypatch.setattr(system, "_nvidia_hardware_count", lambda: 1)
    caps = system.detect_capabilities(cfg(), deep=False)
    issue = next(i for i in caps.issues if i.code == "nvidia_kernel_failure")
    assert issue.repairable is False
