import pytest

from lab_agent.executors import docker
from lab_agent.executors.base import CommandResult
from lab_agent.executors.docker import ContainerOptions, DockerError, Mounts, build_run_args


def mounts():
    return Mounts("/fast/bio", "/cold/bio", "/run/agent/labquota/bio",
                  "/etc/lab-agent/security/lab-codex-seccomp.json", "lab-codex")


def test_runc_host_userns_outer_container_contract():
    opts = ContainerOptions(image="custom-ssh", cpus="8", memory="16g", shm_size="2g",
                            rootfs_quota="100g", ssh_port=50012)
    args = build_run_args("lab-bio", opts, mounts(), gpus=True)
    joined = " ".join(args)
    assert "--runtime=runc" in args
    assert "--userns=host" in args
    assert "--device nvidia.com/gpu=all" in joined
    assert "seccomp=/etc/lab-agent/security/lab-codex-seccomp.json" in joined
    assert "apparmor=unconfined" in joined
    assert "systempaths=unconfined" in joined
    for capability in ("SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE"):
        assert f"--cap-add {capability}" in joined
    assert "source=/fast/bio,target=/home" in joined
    assert "source=/cold/bio,target=/cold-storage" in joined
    assert "target=/run/labquota,readonly" in joined
    assert "--storage-opt size=100g" in joined
    assert "--stop-signal SIGTERM" in joined
    assert "SIGRTMIN+3" not in joined
    for forbidden in ("--privileged", "/var/run/docker.sock", "no-new-privileges",
                      "seccomp=unconfined"):
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


def test_ensure_image_always_pulls_mutable_tag(monkeypatch):
    calls = []

    def pulled(argv, **kwargs):
        calls.append(argv)
        return CommandResult(True, argv, 0, "latest: Pulling from ec061/custom-ssh")

    monkeypatch.setattr(docker, "run", pulled)
    docker.ensure_image("ghcr.io/ec061/custom-ssh:latest")
    assert calls == [["docker", "pull", "ghcr.io/ec061/custom-ssh:latest"]]


def test_ensure_image_fails_closed_when_pull_fails(monkeypatch):
    monkeypatch.setattr(
        docker,
        "run",
        lambda argv, **kwargs: CommandResult(False, argv, 1, stderr="registry unavailable"),
    )
    with pytest.raises(DockerError, match="failed to pull image"):
        docker.ensure_image("ghcr.io/ec061/custom-ssh:latest")


def test_usage_helpers(monkeypatch):
    monkeypatch.setattr(docker, "run", lambda *a, **k: CommandResult(True, [], 0, "123\n", ""))
    assert docker.writable_layer_size("lab-bio") == 123
    assert docker.du_home("lab-bio", "alice") == 123


def test_wait_ssh_ready_completes_key_exchange(monkeypatch):
    calls = []

    def ready(name, argv, **kwargs):
        calls.append((name, argv))
        return CommandResult(True, argv, 0)

    monkeypatch.setattr(docker, "exec_in", ready)
    assert docker.wait_ssh_ready("lab-bio", timeout=0, interval=0)
    assert calls == [("lab-bio", [
        "sh",
        "-c",
        'test "$(cat /proc/1/comm)" = sshd && /usr/sbin/sshd -t '
        '&& test -n "$(ssh-keyscan -T 5 -t ed25519 127.0.0.1 2>/dev/null)"',
    ])]


def test_wait_ssh_ready_times_out(monkeypatch):
    monkeypatch.setattr(
        docker,
        "exec_in",
        lambda name, argv, **kwargs: CommandResult(False, argv, 1),
    )
    assert not docker.wait_ssh_ready("lab-bio", timeout=0, interval=0)
