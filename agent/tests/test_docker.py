import pytest

from lab_agent.executors import docker
from lab_agent.executors.base import CommandResult
from lab_agent.executors.docker import (
    ContainerOptions,
    DockerError,
    Mounts,
    build_run_args,
    container_name,
    du_home,
    sanitize_env,
    validate_image,
    writable_layer_size,
)


def _mounts():
    return Mounts(
        fast_shared="/fast/labs/bio/shared",
        slow_shared="/slow/labs/bio/shared",
        fast_users="/fast/labs/bio/users",
        slow_users="/slow/labs/bio/users",
    )


def test_container_name():
    assert container_name("bio") == "lab-bio"


def test_build_run_args_includes_gpu_via_cdi_and_sysbox_runtime():
    opts = ContainerOptions(image="custom-ssh", cpus="8", memory="16g", shm_size="2g",
                            image_quota="100g", ssh_port=50012, restart="unless-stopped")
    args = build_run_args("lab-bio", opts, _mounts(), gpus=True)
    joined = " ".join(args)
    # Sysbox runtime + CDI GPU injection, NOT the (incompatible) nvidia runtime.
    assert "--runtime=sysbox-runc" in joined
    assert "--device nvidia.com/gpu=all" in joined
    assert "--gpus all" not in joined
    assert "--runtime=nvidia" not in joined
    assert "--cpus 8" in joined
    assert "--memory 16g" in joined
    assert "--shm-size 2g" in joined
    assert "-p 50012:22" in joined
    assert "--storage-opt size=100g" in joined
    assert args[-1] == "custom-ssh"


def test_build_run_args_always_uses_sysbox_runtime():
    args = build_run_args("lab-bio", ContainerOptions(ssh_port=1), _mounts(), gpus=False)
    assert "--runtime=sysbox-runc" in args


def test_build_run_args_omits_gpu_when_absent():
    args = build_run_args("lab-bio", ContainerOptions(ssh_port=1), _mounts(), gpus=False)
    assert "--gpus" not in args
    assert "nvidia.com/gpu=all" not in " ".join(args)


def test_build_run_args_mounts_shared_and_users_rshared():
    args = build_run_args("lab-bio", ContainerOptions(ssh_port=1), _mounts(), gpus=False)
    joined = " ".join(args)
    assert "/fast/labs/bio/shared:/labdata/fast" in joined
    assert "/slow/labs/bio/shared:/labdata/slow" in joined
    assert "type=bind,source=/fast/labs/bio/users,target=/labusers/fast,bind-propagation=rshared" in joined
    assert "type=bind,source=/slow/labs/bio/users,target=/labusers/slow,bind-propagation=rshared" in joined


def test_build_run_args_no_storage_opt_without_zfs_driver():
    args = build_run_args("lab-bio", ContainerOptions(ssh_port=1), _mounts(), gpus=False,
                          storage_quota_supported=False)
    assert "--storage-opt" not in args


def test_build_run_args_stamps_managed_labels():
    labels = {"lab-agent.managed": "true", "lab-agent.lab": "bio", "lab-agent.node": "gpu-1"}
    args = build_run_args("lab-bio", ContainerOptions(ssh_port=1), _mounts(), gpus=False,
                          labels=labels)
    assert "--label" in args
    assert "lab-agent.managed=true" in args
    assert "lab-agent.lab=bio" in args
    assert "lab-agent.node=gpu-1" in args


def test_build_run_args_no_labels_by_default():
    args = build_run_args("lab-bio", ContainerOptions(ssh_port=1), _mounts(), gpus=False)
    assert "--label" not in args


def test_options_from_params():
    opts = ContainerOptions.from_params({
        "image": "myimg",
        "ssh_port": 50001,
        "container_options": {"cpus": 2, "memory": "4g", "image_quota": "30g"},
    })
    assert opts.image == "myimg"
    assert opts.cpus == "2"
    assert opts.memory == "4g"
    assert opts.ssh_port == 50001
    assert opts.image_quota == "30g"


def test_validate_image_rejects_flag_injection_and_junk():
    assert validate_image("custom-ssh") == "custom-ssh"
    assert validate_image("ghcr.io/org/img:1.2") == "ghcr.io/org/img:1.2"
    for bad in ["-v", "--privileged", "img name", "img;rm", ""]:
        with pytest.raises(DockerError):
            validate_image(bad)


def test_build_run_args_rejects_bad_image():
    with pytest.raises(DockerError):
        build_run_args("lab-bio", ContainerOptions(image="--privileged"), _mounts(), gpus=False)


def test_sanitize_env_drops_bad_keys_and_clamps_values():
    out = sanitize_env({"OK_VAR": "v", "bad key": "x", "WITH_NL": "a\nb", "1BAD": "y"})
    assert out == {"OK_VAR": "v", "WITH_NL": "ab"}


def test_build_run_args_only_emits_sanitized_env():
    opts = ContainerOptions(ssh_port=1, extra_env={"GOOD": "1", "bad-key": "2"})
    args = build_run_args("lab-bio", opts, _mounts(), gpus=False)
    assert "GOOD=1" in args
    assert all("bad-key" not in a for a in args)


def test_writable_layer_size_parses_bytes(monkeypatch):
    monkeypatch.setattr(docker, "run", lambda *a, **k: CommandResult(True, [], 0, "1234567\n", ""))
    assert writable_layer_size("lab-bio") == 1234567


def test_writable_layer_size_none_on_failure(monkeypatch):
    monkeypatch.setattr(docker, "run", lambda *a, **k: CommandResult(False, [], 1, "", "no such"))
    assert writable_layer_size("lab-bio") is None


def test_du_home_parses_leading_int(monkeypatch):
    captured = {}

    def fake_run(args, **kwargs):
        captured["args"] = [str(a) for a in args]
        return CommandResult(True, [], 0, "98304\t/home/alice\n", "")

    monkeypatch.setattr(docker, "run", fake_run)
    assert du_home("lab-bio", "alice") == 98304
    # du runs inside the container against the student's home directory.
    assert captured["args"] == ["docker", "exec", "-i", "lab-bio", "du", "-sB1", "/home/alice"]


def test_du_home_none_on_failure(monkeypatch):
    monkeypatch.setattr(docker, "run", lambda *a, **k: CommandResult(False, [], 1, "", "no such"))
    assert du_home("lab-bio", "alice") is None
