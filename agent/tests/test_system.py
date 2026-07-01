from lab_agent import system
from lab_agent.config import AgentConfig
from lab_agent.executors.base import CommandResult


def cfg(**kw):
    return AgentConfig(controller_url="ws://x", token="t", **kw)


class Runner:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, args, **kwargs):
        command = " ".join(str(x) for x in args)
        self.calls.append(command)
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
        "docker info --format {{.DockerRootDir}}": (True, "/var/lib/docker/231072.231072"),
        "docker info --format {{json .SecurityOptions}}":
            (True, '["name=seccomp,profile=default","name=apparmor"]'),
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
        "zfs get -H -o value mountpoint slow/labs": (True, "/cold-storage"),
    })


def test_structured_healthy_capabilities(monkeypatch):
    monkeypatch.setattr(system, "run", healthy_runner())
    monkeypatch.setattr(system, "_security_profiles_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_subid_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_loaded_driver_version", lambda: "570.1")
    caps = system.detect_capabilities(cfg(), deep=False)
    assert caps.runtime.docker_ok and caps.runtime.userns_ok and caps.runtime.bwrap_ok
    assert caps.nvidia.gpu_count == 1 and caps.nvidia.cdi_ok
    assert caps.health.status == "healthy"
    assert caps.to_dict()["runtime"]["userns_user"] == "labdockremap"
    assert caps.to_dict()["runtime"]["userns_start"] == 231072


def test_userns_remap_still_enabled_blocks_health(monkeypatch):
    # A remapped daemon breaks setuid passwd/sudo under --userns=host, so it must be flagged
    # critical until host-prepare removes the remap and placements are recreated.
    runner = healthy_runner()
    runner.responses["docker info --format {{json .SecurityOptions}}"] = (
        True, '["name=seccomp","name=userns:user=labdockremap"]'
    )
    monkeypatch.setattr(system, "run", runner)
    monkeypatch.setattr(system, "_security_profiles_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_loaded_driver_version", lambda: "570.1")
    caps = system.detect_capabilities(cfg(), deep=False)
    assert caps.health.status == "critical"
    assert any(i.code == "docker_userns" for i in caps.issues)


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


def test_stale_cdi_is_critical(monkeypatch):
    runner = healthy_runner()
    runner.responses["nvidia-ctk cdi list"] = (True, "nvidia.com/gpu=all")
    monkeypatch.setattr(system, "run", runner)
    monkeypatch.setattr(system, "_security_profiles_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_subid_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_loaded_driver_version", lambda: "570.1")
    caps = system.detect_capabilities(cfg(), deep=False)
    assert any(i.code == "nvidia_cdi_stale" and i.repairable for i in caps.issues)


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


def test_docker_root_ok_accepts_userns_remap_nested_path(monkeypatch):
    runner = healthy_runner()
    monkeypatch.setattr(system, "run", runner)
    assert system._docker_root_ok(cfg())


def test_docker_root_ok_rejects_wrong_remap_suffix(monkeypatch):
    runner = healthy_runner()
    runner.responses["docker info --format {{.DockerRootDir}}"] = (True, "/var/lib/docker/0.0")
    monkeypatch.setattr(system, "run", runner)
    assert not system._docker_root_ok(cfg())


def test_stale_seccomp_containers_detects_missing_and_changed_labels(monkeypatch):
    monkeypatch.setattr(system.docker, "security_profile_digest", lambda path: "current")
    monkeypatch.setattr(system, "run", Runner({
        "docker ps": (True, "lab-old\nlab-stale\tprevious\nlab-current\tcurrent\n"),
    }))
    assert system._stale_seccomp_containers(cfg()) == ["lab-old", "lab-stale"]


def test_stale_systempaths_containers_detects_old_contract(monkeypatch):
    monkeypatch.setattr(system, "run", Runner({
        "docker ps": (True, "lab-old\nlab-stale\nlab-current\n"),
        "docker inspect --format {{json .HostConfig.MaskedPaths}}\t{{json .HostConfig.ReadonlyPaths}} lab-old":
            (True, "null\tnull"),
        "docker inspect --format {{json .HostConfig.MaskedPaths}}\t{{json .HostConfig.ReadonlyPaths}} lab-stale":
            (True, '["/proc/kcore"]\t["/proc/sys"]'),
        "docker inspect --format {{json .HostConfig.MaskedPaths}}\t{{json .HostConfig.ReadonlyPaths}} lab-current":
            (True, "[]\t[]"),
    }))
    assert system._stale_systempaths_containers() == ["lab-old", "lab-stale"]


def test_stale_lab_userns_containers_detects_remapped_contract(monkeypatch):
    monkeypatch.setattr(system, "run", Runner({
        "docker ps": (True, "lab-old\nlab-remapped\nlab-current\n"),
        "docker inspect --format {{.HostConfig.UsernsMode}} lab-old": (True, ""),
        "docker inspect --format {{.HostConfig.UsernsMode}} lab-remapped": (True, "default"),
        "docker inspect --format {{.HostConfig.UsernsMode}} lab-current": (True, "host"),
    }))
    assert system._stale_lab_userns_containers() == ["lab-old", "lab-remapped"]


def test_stale_bwrap_capability_containers_detects_missing_contract(monkeypatch):
    monkeypatch.setattr(system, "run", Runner({
        "docker ps": (True, "lab-old\nlab-partial\nlab-current\n"),
        "docker inspect --format {{json .HostConfig.CapAdd}} lab-old": (True, "null"),
        "docker inspect --format {{json .HostConfig.CapAdd}} lab-partial":
            (True, '["CAP_SYS_ADMIN"]'),
        "docker inspect --format {{json .HostConfig.CapAdd}} lab-current":
            (True, '["CAP_SYS_ADMIN","CAP_NET_ADMIN","CAP_SYS_PTRACE"]'),
    }))
    assert system._stale_bwrap_capability_containers() == ["lab-old", "lab-partial"]


def test_deep_doctor_accepts_bwrap_and_cuda_toolkit(monkeypatch):
    runner = healthy_runner()
    runner.responses.update({
        'docker ps --filter label=lab-agent.managed=true --format {{.Names}}\t{{.Label "lab-agent.seccomp-sha256"}}':
            (True, "lab-test\tcurrent\n"),
        "docker ps --filter label=lab-agent.managed=true --format {{.Names}}": (True, "lab-test\n"),
        "docker inspect --format {{json .HostConfig.MaskedPaths}}\t{{json .HostConfig.ReadonlyPaths}} lab-test":
            (True, "[]\t[]"),
        "docker inspect --format {{.HostConfig.UsernsMode}} lab-test": (True, "host"),
        "docker inspect --format {{json .HostConfig.CapAdd}} lab-test":
            (True, '["CAP_SYS_ADMIN","CAP_NET_ADMIN","CAP_SYS_PTRACE"]'),
        "docker exec lab-test getent passwd": (True, "alice:x:10042:10042::/home/alice:/bin/bash\n"),
        "docker exec lab-test stat -c %a /usr/bin/bwrap": (True, "4755"),
        "docker exec -u alice -e HOME=/home/alice -e USER=alice -e LOGNAME=alice lab-test bwrap":
            (True, "bwrap works"),
        "docker exec -u alice -e HOME=/home/alice -e USER=alice -e LOGNAME=alice lab-test nvcc --version":
            (True, ""),
    })
    monkeypatch.setattr(system, "run", runner)
    monkeypatch.setattr(system.docker, "security_profile_digest", lambda path: "current")
    monkeypatch.setattr(system.docker, "wait_ssh_ready", lambda container, **kwargs: True)
    monkeypatch.setattr(system, "_security_profiles_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_subid_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_loaded_driver_version", lambda: "570.1")

    caps = system.detect_capabilities(cfg(), deep=True)

    assert caps.runtime.bwrap_ok
    assert caps.runtime.cuda_toolkit_ok
    assert caps.health.status == "healthy"
    assert not any(i.code == "bubblewrap_failed" for i in caps.issues)
    assert any(command.endswith(
        "bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid -- echo bwrap works"
    ) for command in runner.calls)
