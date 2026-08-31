from dataclasses import replace

import pytest
from storagehelp import make_cfg

from lab_agent import hostprep
from lab_agent.config import AgentConfig
from lab_agent.executors.base import CommandResult
from lab_agent.executors.base import run as real_run
from lab_agent.hostprep import (
    docker_apt_source_line,
    docker_quota_zfs_value,
    merge_daemon_config,
    rewrite_nvidia_apt_list,
)


def cfg():
    return AgentConfig(controller_url="ws://x", token="t")


class Runner:
    """Fakes the zfs/systemctl calls host-prepare issues; anything unlisted (e.g. `cp -a`) falls
    through to a real subprocess so filesystem side effects can be checked for real."""

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
        return real_run(args, **kwargs)


def test_daemon_config_preserves_unrelated_settings():
    merged = merge_daemon_config({"log-driver": "journald"}, cfg(), use_zfs=True)
    assert merged == {
        "log-driver": "journald",
        "data-root": "/var/lib/docker",
        "storage-driver": "zfs",
    }


def test_daemon_config_without_zfs_pools_omits_storage_driver():
    merged = merge_daemon_config({}, cfg(), use_zfs=False)
    assert merged == {"data-root": "/var/lib/docker"}


def test_daemon_config_drops_stale_userns_remap():
    merged = merge_daemon_config({"userns-remap": "labdockremap"}, cfg(), use_zfs=False)
    assert "userns-remap" not in merged


def test_daemon_config_removes_legacy_nvidia_runtime_only():
    merged = merge_daemon_config({
        "default-runtime": "nvidia",
        "runtimes": {
            "nvidia": {"path": "nvidia-container-runtime"},
            "kata": {"path": "kata-runtime"},
        },
    }, cfg(), use_zfs=False)
    assert "default-runtime" not in merged
    assert merged["runtimes"] == {"kata": {"path": "kata-runtime"}}


def test_daemon_config_removes_legacy_cgroupfs_pin():
    merged = merge_daemon_config(
        {"exec-opts": ["native.cgroupdriver=cgroupfs"]}, cfg(), use_zfs=True
    )
    assert "exec-opts" not in merged


def test_daemon_config_preserves_operator_exec_opts():
    merged = merge_daemon_config(
        {"exec-opts": ["native.cgroupdriver=systemd", "other=1"]}, cfg(), use_zfs=True
    )
    assert merged["exec-opts"] == ["native.cgroupdriver=systemd", "other=1"]


def test_docker_dataset_defaults_to_the_first_fast_pool():
    assert make_cfg(fast_pools=["nvme"]).docker_dataset == "nvme/docker"


def test_docker_pool_is_configurable_independently_of_the_fast_tier():
    """Docker must never be pushed onto mergerfs; its pool is its own setting."""
    c = make_cfg(fast_pools=["fast1", "fast2"], docker_pool="nvme0")
    assert c.docker_dataset == "nvme0/docker"
    assert c.storage.fast.uses_mergerfs is True
    # ...and the data-root is not inside the mergerfs tier mount root.
    assert not c.docker_data_root.startswith(c.storage.fast.mount_root + "/")


def test_docker_pool_readiness_is_independent_of_lab_tier_pools(monkeypatch):
    monkeypatch.setattr(hostprep, "_pool_exists", lambda pool: pool == "fast")
    assert hostprep._docker_pool_ready(cfg())


def test_missing_multi_pool_branch_does_not_block_native_docker_zfs(monkeypatch):
    c = make_cfg(fast_pools=["fast1", "fast2"], cold_pools=["cold1"], docker_pool="fast1")
    monkeypatch.setattr(hostprep, "_pool_exists", lambda pool: pool == "fast1")
    assert hostprep._docker_pool_ready(c)


def test_docker_pool_readiness_is_the_same_on_smb_backend(monkeypatch):
    monkeypatch.setattr(hostprep, "_pool_exists", lambda pool: pool == "fast")
    assert hostprep._docker_pool_ready(make_cfg(cold_backend="smb"))


def test_mergerfs_is_installed_only_when_a_tier_needs_it(monkeypatch):
    installed = []
    monkeypatch.setattr(hostprep, "_missing_packages", lambda names: list(names))
    monkeypatch.setattr(hostprep, "_apt_update", lambda: None)
    monkeypatch.setattr(hostprep, "_apt_install", lambda pkgs: installed.extend(pkgs))
    assert hostprep._ensure_mergerfs_if_required(cfg()) is False
    assert installed == []
    assert hostprep._ensure_mergerfs_if_required(make_cfg(cold_pools=["cold1", "cold2"])) is True
    assert "mergerfs" in installed and "attr" in installed


def test_mergerfs_install_is_idempotent(monkeypatch):
    monkeypatch.setattr(hostprep, "_missing_packages", lambda names: [])
    monkeypatch.setattr(hostprep, "_apt_update",
                        lambda: pytest.fail("apt-get update ran with nothing missing"))
    monkeypatch.setattr(hostprep, "_apt_install",
                        lambda pkgs: pytest.fail("apt-get install ran with nothing missing"))
    assert hostprep._ensure_mergerfs_if_required(make_cfg(cold_pools=["cold1", "cold2"])) is True


def test_storage_unit_orders_after_zfs_and_before_docker():
    unit = hostprep.render_storage_unit("/etc/lab-agent/config.toml", "/usr/bin/lab-agent")
    assert "After=zfs.target zfs-mount.service local-fs.target" in unit
    assert "Before=docker.service lab-agent.service" in unit
    assert "ExecStart=/usr/bin/lab-agent storage mount" in unit
    assert "ExecStop=/usr/bin/lab-agent storage unmount" in unit
    assert "RemainAfterExit=yes" in unit
    assert "Environment=LAB_AGENT_CONFIG=/etc/lab-agent/config.toml" in unit


def test_prepare_docker_storage_is_a_noop_without_pools(monkeypatch):
    monkeypatch.setattr(hostprep, "_pool_exists", lambda pool: False)
    runner = Runner({})
    monkeypatch.setattr(hostprep, "run", runner)
    assert hostprep._prepare_docker_storage(cfg()) is False
    assert runner.calls == []


def test_prepare_docker_storage_creates_dataset_on_empty_root(monkeypatch, tmp_path):
    monkeypatch.setattr(hostprep, "_pool_exists", lambda pool: True)
    root = tmp_path / "docker"
    root.mkdir()
    runner = Runner({
        "systemctl stop": (True, ""),
        "zfs list -H -o name fast/docker": (False, ""),
        "zfs create": (True, ""),
        "zfs set quota=": (True, ""),
    })
    monkeypatch.setattr(hostprep, "run", runner)
    c = make_cfg()
    c.storage = replace(c.storage, docker=replace(c.storage.docker, data_root=str(root)))
    assert hostprep._prepare_docker_storage(c) is True
    assert any(call.startswith("zfs create") for call in runner.calls)
    assert any(call.startswith("zfs set quota=1024G fast/docker") for call in runner.calls)


def test_prepare_docker_storage_migrates_existing_content_into_the_dataset(monkeypatch, tmp_path):
    """Simulates the "ZFS pools appear after Docker was already installed plainly" case: the
    data-root already has real content when the dataset is first created, and it must end up
    inside the dataset rather than discarded or left duplicated on the old filesystem."""
    monkeypatch.setattr(hostprep, "_pool_exists", lambda pool: True)
    root = tmp_path / "docker"
    root.mkdir()
    (root / "image-layer.txt").write_text("data")
    runner = Runner({
        "systemctl stop": (True, ""),
        "zfs list -H -o name fast/docker": (False, ""),
        "zfs create": (True, ""),
        "zfs set quota=": (True, ""),
    })
    monkeypatch.setattr(hostprep, "run", runner)
    c = make_cfg()
    c.storage = replace(c.storage, docker=replace(c.storage.docker, data_root=str(root)))
    assert hostprep._prepare_docker_storage(c) is True
    assert (root / "image-layer.txt").read_text() == "data"
    assert not root.with_name("docker.pre-zfs.bak").exists()


def test_prepare_docker_storage_mounts_existing_dataset(monkeypatch, tmp_path):
    monkeypatch.setattr(hostprep, "_pool_exists", lambda pool: True)
    root = tmp_path / "docker"
    runner = Runner({
        "systemctl stop": (True, ""),
        "zfs list -H -o name fast/docker": (True, "fast/docker"),
        "zfs mount fast/docker": (True, ""),
        "zfs set quota=": (True, ""),
    })
    monkeypatch.setattr(hostprep, "run", runner)
    c = make_cfg()
    c.storage = replace(c.storage, docker=replace(c.storage.docker, data_root=str(root)))
    assert hostprep._prepare_docker_storage(c) is True
    assert any(call.startswith("zfs mount fast/docker") for call in runner.calls)
    assert not any(call.startswith("zfs create") for call in runner.calls)


def test_docker_quota_zfs_value():
    assert docker_quota_zfs_value(1024) == "1024G"
    assert docker_quota_zfs_value(0) == "none"


def test_docker_apt_source_line():
    line = docker_apt_source_line("amd64", "noble")
    assert line == (
        "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] "
        "https://download.docker.com/linux/ubuntu noble stable\n"
    )


def test_rewrite_nvidia_apt_list_injects_signed_by():
    raw = "deb https://nvidia.github.io/libnvidia-container/stable/deb/$(ARCH) /\n"
    rewritten = rewrite_nvidia_apt_list(raw)
    assert rewritten == (
        "deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] "
        "https://nvidia.github.io/libnvidia-container/stable/deb/$(ARCH) /\n"
    )


def test_nvidia_cdi_installs_latest_base_and_removes_legacy_runtime(monkeypatch):
    runner = Runner({"apt-get install": (True, ""), "apt-get remove": (True, "")})
    monkeypatch.setattr(hostprep, "run", runner)
    monkeypatch.setattr(hostprep, "_ensure_nvidia_apt_repo", lambda: False)
    monkeypatch.setattr(hostprep, "_apt_update", lambda: None)
    monkeypatch.setattr(
        hostprep, "_dpkg_installed", lambda pkg: pkg == "nvidia-container-toolkit"
    )
    hostprep._ensure_nvidia_cdi_if_present(True)
    assert any("nvidia-container-toolkit-base" in call for call in runner.calls)
    assert any(call == "apt-get remove -y nvidia-container-toolkit" for call in runner.calls)


def test_nvidia_cdi_refresh_uses_packaged_systemd_units(monkeypatch, tmp_path):
    runner = Runner({"systemctl enable --now": (True, "")})
    monkeypatch.setattr(hostprep, "run", runner)
    legacy = tmp_path / "nvidia.yaml"
    legacy.write_text("old")
    monkeypatch.setattr(hostprep, "LEGACY_NVIDIA_CDI_SPEC", legacy)
    hostprep._refresh_nvidia_cdi(True)
    assert not legacy.exists()
    assert runner.calls == [
        "systemctl enable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service"
    ]


def test_legacy_security_assets_are_unloaded_and_removed(monkeypatch, tmp_path):
    apparmor = tmp_path / "old-apparmor"
    distro = tmp_path / "old-distro-profile"
    seccomp = tmp_path / "old-seccomp.json"
    for path in (apparmor, distro, seccomp):
        path.write_text("old")
    monkeypatch.setattr(hostprep, "LEGACY_APPARMOR_PROFILE", apparmor)
    monkeypatch.setattr(hostprep, "LEGACY_DISTRO_NAMESPACE_PROFILE", distro)
    monkeypatch.setattr(hostprep, "LEGACY_SECCOMP_PROFILE", seccomp)
    runner = Runner({"apparmor_parser -R": (True, "")})
    monkeypatch.setattr(hostprep, "run", runner)

    hostprep._remove_legacy_security_assets()

    assert not any(path.exists() for path in (apparmor, distro, seccomp))
    assert runner.calls == [
        f"apparmor_parser -R {apparmor}",
        f"apparmor_parser -R {distro}",
    ]
