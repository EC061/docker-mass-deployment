import json
from importlib import resources

import pytest

from lab_agent import hostprep
from lab_agent.config import AgentConfig
from lab_agent.executors.base import CommandResult
from lab_agent.executors.base import run as real_run
from lab_agent.hostprep import (
    docker_apt_source_line,
    docker_quota_zfs_value,
    mapped_host_id,
    merge_daemon_config,
    replace_subid_entry,
    rewrite_nvidia_apt_list,
    subid_conflicts,
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
    merged = merge_daemon_config({"log-driver": "journald"}, cfg(), use_zfs=True, gpu_present=False)
    assert merged == {
        "log-driver": "journald",
        "userns-remap": "labdockremap",
        "data-root": "/var/lib/docker",
        "storage-driver": "zfs",
    }


def test_daemon_config_without_zfs_pools_omits_storage_driver():
    merged = merge_daemon_config({}, cfg(), use_zfs=False, gpu_present=False)
    assert merged == {"userns-remap": "labdockremap", "data-root": "/var/lib/docker"}


def test_daemon_config_gpu_present_pins_cgroupfs():
    merged = merge_daemon_config({}, cfg(), use_zfs=True, gpu_present=True)
    assert merged["exec-opts"] == ["native.cgroupdriver=cgroupfs"]


def test_daemon_config_gpu_cgroupfs_opt_is_idempotent():
    once = merge_daemon_config({}, cfg(), use_zfs=True, gpu_present=True)
    twice = merge_daemon_config(once, cfg(), use_zfs=True, gpu_present=True)
    assert twice["exec-opts"] == ["native.cgroupdriver=cgroupfs"]


def test_daemon_config_gpu_present_replaces_conflicting_cgroupdriver_opt():
    merged = merge_daemon_config({"exec-opts": ["native.cgroupdriver=systemd"]}, cfg(),
                                  use_zfs=True, gpu_present=True)
    assert merged["exec-opts"] == ["native.cgroupdriver=cgroupfs"]


def test_daemon_config_gpu_present_preserves_unrelated_exec_opts():
    merged = merge_daemon_config({"exec-opts": ["native.cgroupdriver=systemd", "other=1"]}, cfg(),
                                  use_zfs=True, gpu_present=True)
    assert merged["exec-opts"] == ["other=1", "native.cgroupdriver=cgroupfs"]


def test_docker_dataset_follows_fast_pool():
    c = AgentConfig(controller_url="ws://x", token="t", fast_pool="nvme")
    assert c.docker_dataset == "nvme/docker"


def test_zfs_pools_ready_requires_the_slow_pool_on_the_zfs_backend(monkeypatch):
    monkeypatch.setattr(hostprep, "_pool_exists", lambda pool: pool == "fast")
    assert not hostprep._zfs_pools_ready(cfg())
    monkeypatch.setattr(hostprep, "_pool_exists", lambda pool: pool in {"fast", "slow"})
    assert hostprep._zfs_pools_ready(cfg())


def test_zfs_pools_ready_ignores_slow_pool_on_smb_backend(monkeypatch):
    monkeypatch.setattr(hostprep, "_pool_exists", lambda pool: pool == "fast")
    smb_cfg = AgentConfig(controller_url="ws://x", token="t", slow_backend="smb")
    assert hostprep._zfs_pools_ready(smb_cfg)


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
    c = AgentConfig(controller_url="ws://x", token="t", docker_data_root=str(root))
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
    c = AgentConfig(controller_url="ws://x", token="t", docker_data_root=str(root))
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
    c = AgentConfig(controller_url="ws://x", token="t", docker_data_root=str(root))
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


def test_security_assets_include_required_runtime_syscalls():
    root = resources.files("lab_agent").joinpath("assets")
    profile = json.loads(root.joinpath("lab-codex-seccomp.json").read_text())
    allowed = {name for group in profile["syscalls"] if group["action"] == "SCMP_ACT_ALLOW"
               for name in group["names"]}
    assert {"clone", "clone3", "unshare", "setns", "mount", "umount2", "pivot_root",
            "fsopen", "fsconfig", "fsmount", "move_mount", "open_tree", "mount_setattr",
            "seccomp", "prctl", "capset", "chroot"} <= allowed
    apparmor = root.joinpath("lab-codex.apparmor").read_text()
    assert "/usr/bin/bwrap Px -> lab-codex//lab-codex-bwrap" in apparmor
    assert "profile lab-codex//lab-codex-bwrap" in apparmor and "userns," in apparmor
    assert "  remount,\n" in apparmor


def test_running_labs_get_home_owned_npm_prefix(monkeypatch):
    runner = Runner({
        "docker ps": (True, "lab-one\nlab-two\n"),
        "docker exec": (True, ""),
    })
    monkeypatch.setattr(hostprep, "run", runner)
    assert hostprep._configure_running_lab_npm() == ["lab-one", "lab-two"]
    exec_calls = [call for call in runner.calls if call.startswith("docker exec")]
    assert len(exec_calls) == 2
    assert all("prefix=${HOME}/.local" in call for call in exec_calls)
    assert all("/etc/profile.d/lab-npm-user-prefix.sh" in call for call in exec_calls)
    assert all('"$home/.npmrc"' in call for call in exec_calls)
    assert all("10000" in call and "59999" in call for call in exec_calls)


def test_lab_npm_configuration_script_has_valid_shell_syntax():
    result = real_run(["sh", "-n", "-c", hostprep._lab_npm_config_script()])
    assert result.ok, result.logs
