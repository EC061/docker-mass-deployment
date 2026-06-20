from lab_agent.executors.docker import ContainerOptions, Mounts, build_run_args, container_name


def _mounts():
    return Mounts(
        fast_shared="/fast/labs/bio/shared",
        slow_shared="/slow/labs/bio/shared",
        fast_users="/fast/labs/bio/users",
        slow_users="/slow/labs/bio/users",
    )


def test_container_name():
    assert container_name("bio") == "lab-bio"


def test_build_run_args_includes_all_gpus_and_limits():
    opts = ContainerOptions(image="custom-ssh", cpus="8", memory="16g", shm_size="2g",
                            image_quota="100g", ssh_port=50012, restart="unless-stopped")
    args = build_run_args("lab-bio", opts, _mounts(), gpus=True)
    joined = " ".join(args)
    assert "--gpus all" in joined
    assert "--runtime=nvidia" in joined
    assert "--cpus 8" in joined
    assert "--memory 16g" in joined
    assert "--shm-size 2g" in joined
    assert "-p 50012:22" in joined
    assert "--storage-opt size=100g" in joined
    assert args[-1] == "custom-ssh"


def test_build_run_args_omits_gpu_when_absent():
    args = build_run_args("lab-bio", ContainerOptions(ssh_port=1), _mounts(), gpus=False)
    assert "--gpus" not in args


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
