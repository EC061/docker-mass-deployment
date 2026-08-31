import pytest

from lab_agent.executors import docker
from lab_agent.executors.base import CommandResult
from lab_agent.executors.docker import ContainerOptions, DockerError, Mounts, build_run_args


def mounts():
    return Mounts("/fast/bio", "/cold/bio", "/run/agent/labquota/bio")


def test_container_name_and_hostname_scheme():
    assert docker.container_name("bio", "node1") == "bio-node1"
    assert docker.container_hostname("bio", "node1") == "bio-node1"
    # Underscores are legal in a container --name but not in a hostname: only the hostname folds them.
    assert docker.container_name("my_lab", "gpu_1") == "my_lab-gpu_1"
    assert docker.container_hostname("my_lab", "gpu_1") == "my-lab-gpu-1"


def test_hostname_alias_replaces_the_lab_but_never_the_container_name():
    # The alias is cosmetic: the container NAME stays the lab's identity on the node.
    assert docker.container_hostname("Geng_Yuan_Lab", "geass", "gylab") == "gylab-geass"
    assert docker.container_name("Geng_Yuan_Lab", "geass") == "Geng_Yuan_Lab-geass"
    # No alias, empty alias and whitespace-only all fall back to the lab name.
    assert docker.container_hostname("bio", "node1", None) == "bio-node1"
    assert docker.container_hostname("bio", "node1", "") == "bio-node1"
    assert docker.container_hostname("bio", "node1", "   ") == "bio-node1"
    # An alias is sanitized on the same path as the lab name, and still length-capped.
    assert docker.container_hostname("bio", "node1", "my_lab") == "my-lab-node1"
    assert len(docker.container_hostname("bio", "n", "a" * 80)) == 63


def test_hostname_alias_travels_in_container_options():
    opts = ContainerOptions.from_params({"container_options": {"hostname_alias": "gylab"}})
    assert opts.hostname_alias == "gylab"
    # Absent (an older controller) or null must not become the string "None".
    assert ContainerOptions.from_params({}).hostname_alias == ""
    assert ContainerOptions.from_params(
        {"container_options": {"hostname_alias": None}}
    ).hostname_alias == ""


def test_hostname_is_set_on_run():
    args = build_run_args("bio-node1", ContainerOptions(), mounts(), gpus=False,
                          hostname="bio-node1")
    assert "--hostname bio-node1" in " ".join(args)
    # Omitted hostname leaves docker to its default (no flag emitted).
    assert "--hostname" not in build_run_args("bio-node1", ContainerOptions(), mounts(), gpus=False)


def test_normal_docker_security_and_cdi_container_contract():
    opts = ContainerOptions(image="custom-ssh", cpus="8", memory="16g", shm_size="2g",
                            rootfs_quota="100g", ssh_port=50012)
    args = build_run_args("lab-bio", opts, mounts(), gpus=True)
    joined = " ".join(args)
    assert "--device nvidia.com/gpu=all" in joined
    for flag in ("--runtime", "--userns", "--cgroupns", "--security-opt", "--cap-add"):
        assert flag not in args
    assert "--cap-add" not in args
    assert "source=/fast/bio,target=/home" in joined
    assert "source=/cold/bio,target=/cold-storage" in joined
    assert "target=/run/labquota,readonly" in joined
    # RETEST-FIND-7: a per-student dataset mounted after the container started must appear inside
    # it. That needs slave propagation on both persistent binds — Docker's default is rprivate,
    # which silently hides the student's own storage behind the root-owned directory underneath.
    assert "source=/fast/bio,target=/home,bind-propagation=rslave" in joined
    assert "source=/cold/bio,target=/cold-storage,bind-propagation=rslave" in joined
    # Slave, never shared: propagation must not run container -> host.
    assert "bind-propagation=rshared" not in joined
    assert "--storage-opt size=100g" in joined
    for forbidden in ("--privileged", "/var/run/docker.sock", "no-new-privileges",
                      "seccomp=", "apparmor=", "systempaths=unconfined"):
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


def test_parse_human_size_matches_docker_storage_opt_forms():
    assert docker.parse_human_size("300g") == 300 * 1024**3
    assert docker.parse_human_size("2048G") == 2048 * 1024**3
    assert docker.parse_human_size("1.5TiB") == int(1.5 * 1024**4)
    assert docker.parse_human_size("512") == 512
    assert docker.parse_human_size("100kb") == 100 * 1024
    assert docker.parse_human_size("bogus") is None


def test_rootfs_quota_bytes_reads_storage_opt(monkeypatch):
    monkeypatch.setattr(
        docker, "run", lambda *a, **k: CommandResult(True, [], 0, '{"size":"300g"}\n', "")
    )
    assert docker.rootfs_quota_bytes("lab-bio") == 300 * 1024**3
    monkeypatch.setattr(docker, "run", lambda *a, **k: CommandResult(True, [], 0, "null\n", ""))
    assert docker.rootfs_quota_bytes("lab-bio") is None
    monkeypatch.setattr(docker, "run", lambda *a, **k: CommandResult(False, [], 1, "", "err"))
    assert docker.rootfs_quota_bytes("lab-bio") is None


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
