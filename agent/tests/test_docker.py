import pytest

from lab_agent.executors import docker
from lab_agent.executors.base import CommandResult
from lab_agent.executors.docker import ContainerOptions, DockerError, Mounts, build_run_args


def mounts():
    return Mounts("/fast/bio", "/cold/bio", "/run/agent/labquota/bio",
                  "/etc/lab-agent/security/lab-codex-seccomp.json", "lab-codex")


def test_runc_userns_outer_container_contract():
    opts = ContainerOptions(image="custom-ssh", cpus="8", memory="16g", shm_size="2g",
                            rootfs_quota="100g", ssh_port=50012)
    args = build_run_args("lab-bio", opts, mounts(), gpus=True)
    joined = " ".join(args)
    assert "--runtime=runc" in args
    assert "--device nvidia.com/gpu=all" in joined
    assert "seccomp=/etc/lab-agent/security/lab-codex-seccomp.json" in joined
    assert "apparmor=lab-codex" in joined
    assert "source=/fast/bio,target=/home" in joined
    assert "source=/cold/bio,target=/cold-storage" in joined
    assert "target=/run/labquota,readonly" in joined
    assert "--storage-opt size=100g" in joined
    for forbidden in ("--privileged", "--cap-add", "SYS_ADMIN", "/var/run/docker.sock",
                      "no-new-privileges", "seccomp=unconfined"):
        assert forbidden not in joined


def test_gpu_and_rootfs_quota_can_be_omitted():
    args = build_run_args("lab-bio", ContainerOptions(), mounts(), gpus=False,
                          storage_quota_supported=False)
    joined = " ".join(args)
    assert "nvidia.com/gpu" not in joined
    assert "--storage-opt" not in args


def test_options_and_labels():
    opts = ContainerOptions.from_params({"image": "img", "ssh_port": 2222,
        "container_options": {"rootfs_quota": "30g", "extra_env": {"GOOD": "1", "bad-key": "x"}}})
    assert opts.rootfs_quota == "30g"
    args = build_run_args("lab-bio", opts, mounts(), gpus=False,
                          labels={"lab-agent.managed": "true"})
    assert "lab-agent.managed=true" in args and "GOOD=1" in args
    assert all("bad-key" not in item for item in args)


def test_rejects_image_flag_injection():
    with pytest.raises(DockerError):
        build_run_args("lab-bio", ContainerOptions(image="--privileged"), mounts(), gpus=False)


def test_usage_helpers(monkeypatch):
    monkeypatch.setattr(docker, "run", lambda *a, **k: CommandResult(True, [], 0, "123\n", ""))
    assert docker.writable_layer_size("lab-bio") == 123
    assert docker.du_home("lab-bio", "alice") == 123
