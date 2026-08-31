import pytest
from storagehelp import make_cfg

from lab_agent import system
from lab_agent.executors.base import CommandResult
from lab_agent.executors.zfs import MountState, PoolCapacity


@pytest.fixture(autouse=True)
def _no_host_pci_gpus(monkeypatch):
    # _nvidia_hardware_count reads the real /sys/bus/pci/devices; pin it to zero so gpu_count is
    # driven entirely by the mocked nvidia-smi output whatever hardware the test host has. Tests
    # simulating dead-driver-but-hardware-present override it with their own setattr.
    monkeypatch.setattr(system, "_nvidia_hardware_count", lambda: 0)


def cfg(**kw):
    return make_cfg(**kw)


@pytest.fixture(autouse=True)
def _healthy_storage(monkeypatch):
    """Default: every configured pool is imported+ONLINE and its <pool>/labs root is mounted.

    Storage health now goes through storage.service (which shells out via the zfs executor, not
    system.run), so tests stub that layer here and override it when they want a broken tier.
    """
    monkeypatch.setattr(system.service.zfs, "pool_capacity",
                        lambda pool: PoolCapacity(pool, 1000, 400, 600, "ONLINE"))
    monkeypatch.setattr(system.service.zfs, "mount_state",
                        lambda ds, expected=None: MountState(ds, True, True, expected, expected))
    monkeypatch.setattr(system.zfs, "dataset_exists", lambda ds: True)
    monkeypatch.setattr(system.zfs, "mount_state",
                        lambda ds, expected=None: MountState(ds, True, True, expected, expected))
    monkeypatch.setattr(system.mfs, "available", lambda: True)
    monkeypatch.setattr(system.service, "discover_labs", lambda tier: [])


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
    caps = system.detect_capabilities(cfg(cold_backend="smb"), deep=False)
    assert any(i.code == "cold_storage_missing" for i in caps.issues)


# ------------------------------------------------------------------ multi-pool storage health


def _pools_online(monkeypatch, online: set[str]):
    monkeypatch.setattr(
        system.service.zfs, "pool_capacity",
        lambda pool: PoolCapacity(pool, 1000, 400, 600, "ONLINE") if pool in online else None,
    )
    monkeypatch.setattr(
        system.service.zfs, "mount_state",
        lambda ds, expected=None: MountState(
            ds, ds.split("/")[0] in online, ds.split("/")[0] in online,
            expected if ds.split("/")[0] in online else None, expected,
        ),
    )


def _base(monkeypatch):
    monkeypatch.setattr(system, "run", healthy_runner())
    monkeypatch.setattr(system, "_security_profiles_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_subid_ok", lambda cfg: True)
    monkeypatch.setattr(system, "_loaded_driver_version", lambda: "570.1")


def test_one_lost_pool_of_two_is_degraded_not_unavailable(monkeypatch):
    _base(monkeypatch)
    _pools_online(monkeypatch, {"cold1", "fast"})
    caps = system.detect_capabilities(
        cfg(cold_pools=["cold1", "cold2"], docker_pool="fast"), deep=False
    )
    cold = next(t for t in caps.storage.tiers if t.tier == "cold")
    assert cold.status == "degraded"
    assert cold.unavailable_pools == ["cold2"]
    issue = next(i for i in caps.issues if i.code == "cold_storage_degraded")
    assert "cold2" in issue.message
    # Surviving branches stay usable: the tier is not reported as gone.
    assert caps.storage.cold_ok is False and cold.status != "unavailable"


def test_losing_every_pool_of_a_tier_is_unavailable(monkeypatch):
    _base(monkeypatch)
    _pools_online(monkeypatch, {"fast"})
    caps = system.detect_capabilities(
        cfg(cold_pools=["cold1", "cold2"], docker_pool="fast"), deep=False
    )
    cold = next(t for t in caps.storage.tiers if t.tier == "cold")
    assert cold.status == "unavailable"
    assert any(i.code == "cold_storage_missing" for i in caps.issues)


def test_an_unmounted_pool_root_is_not_treated_as_a_usable_branch(monkeypatch):
    """The pool is imported but <pool>/labs is not mounted: an empty directory is NOT a branch."""
    _base(monkeypatch)
    monkeypatch.setattr(system.service.zfs, "pool_capacity",
                        lambda pool: PoolCapacity(pool, 1000, 400, 600, "ONLINE"))
    monkeypatch.setattr(
        system.service.zfs, "mount_state",
        lambda ds, expected=None: MountState(ds, True, ds != "cold2/labs",
                                             expected if ds != "cold2/labs" else None, expected),
    )
    caps = system.detect_capabilities(
        cfg(cold_pools=["cold1", "cold2"], docker_pool="fast"), deep=False
    )
    cold = next(t for t in caps.storage.tiers if t.tier == "cold")
    assert cold.unavailable_pools == ["cold2"]


def test_missing_mergerfs_binary_is_critical_and_repairable(monkeypatch):
    _base(monkeypatch)
    monkeypatch.setattr(system.mfs, "available", lambda: False)
    caps = system.detect_capabilities(cfg(cold_pools=["cold1", "cold2"]), deep=False)
    issue = next(i for i in caps.issues if i.code == "cold_mergerfs_missing")
    assert issue.repairable is True
    # A single-pool zfs tier never needs mergerfs, so it raises no issue.
    assert not any(i.code == "fast_mergerfs_missing" for i in caps.issues)


def test_docker_must_stay_off_mergerfs(monkeypatch):
    from dataclasses import replace

    _base(monkeypatch)
    c = cfg(fast_pools=["fast1", "fast2"], docker_pool="fast1")
    c.storage = replace(
        c.storage, docker=replace(c.storage.docker, data_root="/fast/docker"),
    )
    caps = system.detect_capabilities(c, deep=False)
    assert any(i.code == "docker_on_mergerfs" for i in caps.issues)
    assert caps.storage.docker_pool == "fast1"


def test_doctor_flags_a_logical_mount_that_is_down(monkeypatch):
    _base(monkeypatch)
    monkeypatch.setattr(system.service, "discover_labs", lambda tier: ["bio"])
    monkeypatch.setattr(system.mfs, "is_mergerfs_mount", lambda path: False)
    monkeypatch.setattr(system, "_quota_violations", lambda cfg: [])
    monkeypatch.setattr(system, "_stale_seccomp_containers", lambda cfg: [])
    monkeypatch.setattr(system, "_stale_systempaths_containers", lambda: [])
    monkeypatch.setattr(system, "_stale_lab_userns_containers", lambda: [])
    monkeypatch.setattr(system, "_stale_bwrap_capability_containers", lambda: [])
    monkeypatch.setattr(system, "_stale_bind_propagation_containers", lambda: [])
    monkeypatch.setattr(system, "_stale_apparmor_containers", lambda cfg: [])
    monkeypatch.setattr(system, "_first_student_container", lambda: None)
    caps = system.detect_capabilities(cfg(cold_pools=["cold1", "cold2"]), deep=True)
    issue = next(i for i in caps.issues if i.code == "cold_logical_mount_missing")
    assert "/cold-storage/bio" in issue.message


def test_doctor_flags_an_unexpected_dead_branch_in_a_union(monkeypatch):
    tier = cfg(cold_pools=["cold1", "cold2"]).storage.cold
    expected = tier.branch_mount("cold1", "bio")
    stale = tier.branch_mount("cold2", "bio")
    monkeypatch.setattr(system.service, "discover_labs", lambda _tier: ["bio"])
    monkeypatch.setattr(system.mfs, "is_mergerfs_mount", lambda path: True)
    monkeypatch.setattr(system.mfs, "current_branches", lambda path: [expected, stale])
    monkeypatch.setattr(
        system.service,
        "observe_branches",
        lambda _tier, lab: [system.service.BranchObservation(
            "cold1", tier.branch_dataset("cold1", lab), expected, True,
            0, 1, 1, 100, 100, pool_usable=True,
        )],
    )
    assert system._bad_logical_mounts(tier) == [
        f"/cold-storage/bio (unexpected: {stale})"
    ]


def test_doctor_flags_a_branch_quota_sum_over_the_configured_quota(monkeypatch):
    _base(monkeypatch)
    monkeypatch.setattr(system.service, "discover_labs", lambda tier: [])
    monkeypatch.setattr(system, "_quota_violations",
                        lambda cfg: ["cold/bio committed 3000 > configured 2000"])
    monkeypatch.setattr(system, "_stale_seccomp_containers", lambda cfg: [])
    monkeypatch.setattr(system, "_stale_systempaths_containers", lambda: [])
    monkeypatch.setattr(system, "_stale_lab_userns_containers", lambda: [])
    monkeypatch.setattr(system, "_stale_bwrap_capability_containers", lambda: [])
    monkeypatch.setattr(system, "_stale_bind_propagation_containers", lambda: [])
    monkeypatch.setattr(system, "_stale_apparmor_containers", lambda cfg: [])
    monkeypatch.setattr(system, "_first_student_container", lambda: None)
    caps = system.detect_capabilities(cfg(), deep=True)
    assert any(i.code == "storage_quota_invariant" for i in caps.issues)
    assert caps.storage.quota_invariant_ok is False


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


def test_stale_bind_propagation_containers_detects_private_binds(monkeypatch):
    """RETEST-FIND-7: an rprivate bind never shows a per-student dataset mounted after container
    start, so the member silently gets the root-owned directory underneath instead of their own
    storage. Propagation is fixed at creation, so such a container has to be recreated."""
    inspect = "docker inspect --format {{range .HostConfig.Mounts}}{{.Target}}={{.BindOptions.Propagation}} {{end}}"
    monkeypatch.setattr(system, "run", Runner({
        "docker ps": (True, "lab-old\nlab-half\nlab-current\n"),
        f"{inspect} lab-old": (True, "/home=rprivate /cold-storage=rprivate"),
        f"{inspect} lab-half": (True, "/home=rslave /cold-storage=rprivate"),
        f"{inspect} lab-current":
            (True, "/home=rslave /cold-storage=rslave /run/labquota=rprivate"),
    }))
    assert system._stale_bind_propagation_containers() == ["lab-old", "lab-half"]


def test_stale_apparmor_containers_detects_unconfined(monkeypatch):
    # Unprivileged bwrap cannot write its own uid_map when the task is AppArmor-unconfined, so an
    # unconfined lab (or one whose profile cannot be read) must be flagged for recreation.
    monkeypatch.setattr(system, "run", Runner({
        "docker ps": (True, "lab-old\nlab-unconfined\nlab-current\n"),
        "docker inspect --format {{.AppArmorProfile}} lab-old": (True, ""),
        "docker inspect --format {{.AppArmorProfile}} lab-unconfined": (True, "unconfined"),
        "docker inspect --format {{.AppArmorProfile}} lab-current": (True, "lab-codex"),
    }))
    assert system._stale_apparmor_containers(cfg()) == ["lab-old", "lab-unconfined"]


def test_stale_bwrap_capability_containers_detects_legacy_capabilities(monkeypatch):
    monkeypatch.setattr(system, "run", Runner({
        "docker ps": (True, "lab-current\nlab-partial\nlab-legacy\n"),
        "docker inspect --format {{json .HostConfig.CapAdd}} lab-current": (True, "null"),
        "docker inspect --format {{json .HostConfig.CapAdd}} lab-partial":
            (True, '["CAP_SYS_ADMIN"]'),
        "docker inspect --format {{json .HostConfig.CapAdd}} lab-legacy":
            (True, '["CAP_SYS_ADMIN","CAP_NET_ADMIN","CAP_SYS_PTRACE"]'),
    }))
    assert system._stale_bwrap_capability_containers() == ["lab-partial", "lab-legacy"]


def test_deep_doctor_accepts_bwrap_and_cuda_toolkit(monkeypatch):
    runner = healthy_runner()
    runner.responses.update({
        'docker ps --filter label=lab-agent.managed=true --format {{.Names}}\t{{.Label "lab-agent.seccomp-sha256"}}':
            (True, "lab-test\tcurrent\n"),
        "docker ps --filter label=lab-agent.managed=true --format {{.Names}}": (True, "lab-test\n"),
        "docker inspect --format {{json .HostConfig.MaskedPaths}}\t{{json .HostConfig.ReadonlyPaths}} lab-test":
            (True, "[]\t[]"),
        "docker inspect --format {{.HostConfig.UsernsMode}} lab-test": (True, "host"),
        "docker inspect --format {{range .HostConfig.Mounts}}{{.Target}}={{.BindOptions.Propagation}} {{end}} lab-test":
            (True, "/home=rslave /cold-storage=rslave"),
        "docker inspect --format {{json .HostConfig.CapAdd}} lab-test": (True, "null"),
        "docker inspect --format {{.AppArmorProfile}} lab-test": (True, "lab-codex"),
        "docker exec lab-test getent passwd": (True, "alice:x:10042:10042::/home/alice:/bin/bash\n"),
        "docker exec lab-test stat -c %a /usr/bin/bwrap": (True, "755"),
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
        "docker inspect --format {{json .HostConfig.CapAdd}} lab-test": (True, "null"),
        "docker inspect --format {{.AppArmorProfile}} lab-test": (True, "lab-codex"),
        "docker exec lab-test getent passwd": (True, "alice:x:10042:10042::/home/alice:/bin/bash\n"),
        "docker exec lab-test stat -c %a /usr/bin/bwrap": (True, "755"),
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


def test_unconfined_container_is_flagged_stale(monkeypatch):
    runner = healthy_runner()
    runner.responses.update({
        'docker ps --filter label=lab-agent.managed=true --format {{.Names}}\t{{.Label "lab-agent.seccomp-sha256"}}':
            (True, "lab-test\tcurrent\n"),
        "docker ps --filter label=lab-agent.managed=true --format {{.Names}}": (True, "lab-test\n"),
        "docker inspect --format {{json .HostConfig.MaskedPaths}}\t{{json .HostConfig.ReadonlyPaths}} lab-test":
            (True, "[]\t[]"),
        "docker inspect --format {{.HostConfig.UsernsMode}} lab-test": (True, "host"),
        "docker inspect --format {{json .HostConfig.CapAdd}} lab-test": (True, "null"),
        # Container was created unconfined (by the previous setuid-bwrap contract): unprivileged
        # bwrap cannot write its uid_map there, so doctor must demand recreation.
        "docker inspect --format {{.AppArmorProfile}} lab-test": (True, "unconfined"),
        "docker exec lab-test getent passwd": (True, "alice:x:10042:10042::/home/alice:/bin/bash\n"),
        "docker exec lab-test stat -c %a /usr/bin/bwrap": (True, "755"),
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

    if sys.platform != "linux":
        pytest.skip("the seccomp syscall probe is Linux-only")

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
