import pytest

from lab_agent import system
from lab_agent.config import AgentConfig
from lab_agent.executors.base import CommandResult


@pytest.fixture(autouse=True)
def _no_host_pci_gpus(monkeypatch):
    # _nvidia_hardware_count reads the real /sys/bus/pci/devices; pin it to zero so gpu_count is
    # driven entirely by the mocked nvidia-smi output whatever hardware the test host has. Tests
    # simulating dead-driver-but-hardware-present override it with their own setattr.
    monkeypatch.setattr(system, "_nvidia_hardware_count", lambda: 0)


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


def test_stale_apparmor_containers_detects_confined(monkeypatch):
    monkeypatch.setattr(system, "run", Runner({
        "docker ps": (True, "lab-old\nlab-confined\nlab-current\n"),
        "docker inspect --format {{.AppArmorProfile}} lab-old": (True, ""),
        "docker inspect --format {{.AppArmorProfile}} lab-confined": (True, "lab-codex"),
        "docker inspect --format {{.AppArmorProfile}} lab-current": (True, "unconfined"),
    }))
    assert system._stale_apparmor_containers() == ["lab-old", "lab-confined"]


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
        "docker inspect --format {{.AppArmorProfile}} lab-test": (True, "unconfined"),
        "docker exec lab-test getent passwd": (True, "alice:x:10042:10042::/home/alice:/bin/bash\n"),
        "docker exec lab-test stat -c %a /usr/bin/bwrap": (True, "4755"),
        "docker exec -u alice -e HOME=/home/alice -e USER=alice -e LOGNAME=alice lab-test bwrap":
            (True, "bwrap works"),
        # Seccomp enforcement: add_key returns EPERM (probe exits 0 = blocked).
        "docker exec -u alice -e HOME=/home/alice -e USER=alice -e LOGNAME=alice lab-test python3":
            (True, ""),
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
    assert not any(i.code == "seccomp_enforcement_failed" for i in caps.issues)
    assert not any(i.code == "container_apparmor_stale" for i in caps.issues)
    assert any(command.endswith(
        "bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid -- echo bwrap works"
    ) for command in runner.calls)


def test_seccomp_enforcement_failure_is_critical(monkeypatch):
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
        "docker inspect --format {{.AppArmorProfile}} lab-test": (True, "unconfined"),
        "docker exec lab-test getent passwd": (True, "alice:x:10042:10042::/home/alice:/bin/bash\n"),
        "docker exec lab-test stat -c %a /usr/bin/bwrap": (True, "4755"),
        "docker exec -u alice -e HOME=/home/alice -e USER=alice -e LOGNAME=alice lab-test bwrap":
            (True, "bwrap works"),
        # Seccomp enforcement: add_key not blocked with EPERM (probe exits 1 = not enforcing).
        "docker exec -u alice -e HOME=/home/alice -e USER=alice -e LOGNAME=alice lab-test python3":
            (False, ""),
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
    issue = next(i for i in caps.issues if i.code == "seccomp_enforcement_failed")
    assert issue.severity == "critical"
    assert issue.repairable is True


def test_confined_container_is_flagged_stale(monkeypatch):
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
        # Container was created confined (e.g. by a since-reverted agent): setuid bwrap breaks
        # under confinement, so doctor must demand recreation.
        "docker inspect --format {{.AppArmorProfile}} lab-test": (True, "lab-codex"),
        "docker exec lab-test getent passwd": (True, "alice:x:10042:10042::/home/alice:/bin/bash\n"),
        "docker exec lab-test stat -c %a /usr/bin/bwrap": (True, "4755"),
        "docker exec -u alice -e HOME=/home/alice -e USER=alice -e LOGNAME=alice lab-test bwrap":
            (True, "bwrap works"),
        "docker exec -u alice -e HOME=/home/alice -e USER=alice -e LOGNAME=alice lab-test python3":
            (True, ""),
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

    issue = next(i for i in caps.issues if i.code == "container_apparmor_stale")
    assert issue.severity == "critical"
    assert "lab-test" in issue.message


def test_seccomp_probe_exit_code_tracks_eperm():
    """The probe must exit 0 exactly when the syscall fails with EPERM (seccomp enforcing).

    Runs the real probe script in a subprocess and compares it against the errno the same
    syscall produces in-process, so an inverted mapping fails regardless of whether the test
    host itself filters add_key(2).
    """
    import ctypes
    import subprocess
    import sys

    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    libc.syscall(248, 0, 0, 0, 0)
    errno = ctypes.get_errno()
    proc = subprocess.run([sys.executable, "-c", system.SECCOMP_PROBE], timeout=30)
    assert proc.returncode == (0 if errno == 1 else 1)


def test_seccomp_enforcement_ok_returns_true_on_blocked(monkeypatch):
    monkeypatch.setattr(system, "run", lambda *a, **k: CommandResult(True, [], 0, "", ""))
    assert system._seccomp_enforcement_ok("lab-test", "alice")


def test_seccomp_enforcement_ok_returns_false_on_unconfined(monkeypatch):
    monkeypatch.setattr(system, "run", lambda *a, **k: CommandResult(False, [], 1, "", ""))
    assert not system._seccomp_enforcement_ok("lab-test", "alice")
