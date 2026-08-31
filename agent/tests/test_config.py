import os
from pathlib import Path

import pytest
from storagehelp import make_cfg

from lab_agent.config import AgentConfig, load_config, save_config
from lab_agent.storage.model import StorageConfigError


def write(tmp_path: Path, body: str, name: str = "config.toml") -> Path:
    path = tmp_path / name
    path.write_text(body)
    return path


BASE = '[agent]\ncontroller_url = "wss://c"\ntoken = "t"\nnode_name = "gpu-01"\n'


def test_render_and_load_roundtrip(tmp_path: Path):
    cfg = AgentConfig(
        controller_url="wss://controller.example:8443",
        token="secret-token",
        node_name="gpu-01",
        heartbeat_interval_s=30,
        tls_verify=False,
    )
    path = tmp_path / "config.toml"
    save_config(cfg, path)

    text = path.read_text()
    assert 'controller_url = "wss://controller.example:8443"' in text
    assert "tls_verify = false" in text
    assert "heartbeat_interval_s = 30" in text

    loaded = load_config(path)
    assert loaded.controller_url == cfg.controller_url
    assert loaded.token == cfg.token
    assert loaded.node_name == "gpu-01"
    assert loaded.heartbeat_interval_s == 30
    assert loaded.tls_verify is False


def test_missing_config_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        load_config(tmp_path / "nope.toml")


def test_saved_config_is_owner_only(tmp_path: Path):
    cfg = AgentConfig(controller_url="ws://x", token="t")
    path = save_config(cfg, tmp_path / "c.toml")
    assert (path.stat().st_mode & 0o777) == 0o600


# --------------------------------------------------------------------------- legacy compatibility


def test_legacy_scalar_config_still_loads(tmp_path: Path):
    """A pre-multi-pool config.toml keeps working, converted into the new internal model."""
    path = write(tmp_path, BASE + 'fast_pool = "fast"\nslow_pool = "slow"\nslow_backend = "zfs"\n')
    cfg = load_config(path)
    assert cfg.storage.fast.backend == "zfs"
    assert cfg.storage.fast.pools == ("fast",)
    assert cfg.storage.cold.backend == "zfs"
    assert cfg.storage.cold.pools == ("slow",)
    # Docker defaults onto the fast pool, exactly where it already lives on such a node.
    assert cfg.storage.docker.pool == "fast"
    assert cfg.docker_dataset == "fast/docker"
    # And the container-facing paths are unchanged.
    assert cfg.storage.fast.logical_mount("bio") == "/fast/bio"
    assert cfg.storage.fast.branch_mount("fast", "bio") == "/fast/bio"
    assert cfg.storage.cold.logical_mount("bio") == "/cold-storage/bio"


def test_legacy_custom_pool_names_and_mount_roots(tmp_path: Path):
    path = write(tmp_path, BASE + (
        'fast_pool = "nvme"\nslow_pool = "bulk"\n'
        'fast_mount_root = "/fast"\ncold_mount_root = "/cold-storage"\n'
        'docker_dataset_name = "dockerd"\ndocker_quota_gb = 512\n'
    ))
    cfg = load_config(path)
    assert cfg.storage.fast.pools == ("nvme",)
    assert cfg.docker_dataset == "nvme/dockerd"
    assert cfg.docker_quota_gb == 512
    assert cfg.scrub_pools == ["nvme", "bulk"]


def test_legacy_smb_cold_config(tmp_path: Path):
    path = write(tmp_path, BASE + 'slow_backend = "smb"\nslow_path = "/cold-storage"\n')
    cfg = load_config(path)
    assert cfg.slow_backend == "smb"
    assert cfg.slow_is_zfs is False
    assert cfg.cold_root == "/cold-storage"
    # An SMB client owns no cold pools, so it never scrubs them.
    assert cfg.scrub_pools == ["fast"]


def test_saving_a_legacy_config_migrates_it_to_the_storage_schema(tmp_path: Path):
    path = write(tmp_path, BASE + 'fast_pool = "fast"\nslow_pool = "slow"\n')
    cfg = load_config(path)
    save_config(cfg, path)
    text = path.read_text()
    assert "[storage.fast]" in text and "[storage.cold]" in text and "[storage.docker]" in text
    assert "fast_pool" not in text
    # And the migrated file loads back to the same model.
    assert load_config(path).storage.to_dict() == cfg.storage.to_dict()


def test_legacy_and_new_sections_can_be_mixed(tmp_path: Path):
    """Migration is incremental: keep fast_pool, add only [storage.cold] for the second disk."""
    path = write(tmp_path, BASE + 'fast_pool = "fast"\n\n'
                 '[storage.cold]\nbackend = "mergerfs"\npools = ["cold1", "cold2"]\n')
    cfg = load_config(path)
    assert cfg.storage.fast.backend == "zfs" and cfg.storage.fast.pools == ("fast",)
    assert cfg.storage.cold.backend == "mergerfs"
    assert cfg.storage.cold.pools == ("cold1", "cold2")
    assert cfg.storage.docker.pool == "fast"


# --------------------------------------------------------------------------- new schema


def test_new_single_pool_config(tmp_path: Path):
    path = write(tmp_path, BASE + '\n[storage.fast]\nbackend = "zfs"\npools = ["fast1"]\n'
                 '\n[storage.cold]\nbackend = "zfs"\npools = ["cold1"]\n')
    cfg = load_config(path)
    assert cfg.storage.fast.pools == ("fast1",)
    assert cfg.storage.fast.uses_mergerfs is False
    # Single-pool zfs tier mounts the dataset straight at the logical path (no FUSE).
    assert cfg.storage.fast.branch_mount("fast1", "bio") == "/fast/bio"
    assert cfg.storage.docker.pool == "fast1"


def test_new_multi_pool_fast_and_cold(tmp_path: Path):
    path = write(tmp_path, BASE + (
        '\n[storage.fast]\nbackend = "mergerfs"\npools = ["fast1", "fast2"]\n'
        'mount_root = "/fast"\n'
        '\n[storage.cold]\nbackend = "mergerfs"\npools = ["cold1", "cold2", "cold3"]\n'
        'mount_root = "/cold-storage"\n'
        '\n[storage.docker]\npool = "fast1"\ndataset = "docker"\nquota_gb = 2048\n'
    ))
    cfg = load_config(path)
    assert cfg.storage.fast.pools == ("fast1", "fast2")
    assert cfg.storage.cold.pools == ("cold1", "cold2", "cold3")
    assert cfg.storage.docker.dataset == "fast1/docker"
    assert cfg.docker_quota_gb == 2048
    assert cfg.scrub_pools == ["fast1", "fast2", "cold1", "cold2", "cold3"]
    # Branch datasets live out of container sight; the logical path is unchanged.
    assert cfg.storage.cold.branch_mount("cold2", "bio") == "/mnt/lab-storage/cold2/labs/bio"
    assert cfg.storage.cold.logical_mount("bio") == "/cold-storage/bio"


def test_docker_pool_is_independent_of_the_fast_tier(tmp_path: Path):
    """Docker must be able to sit on a pool that backs no lab tier at all."""
    path = write(tmp_path, BASE + (
        '\n[storage.fast]\nbackend = "mergerfs"\npools = ["fast1", "fast2"]\n'
        '\n[storage.docker]\npool = "nvme0"\n'
    ))
    cfg = load_config(path)
    assert cfg.storage.docker.dataset == "nvme0/docker"
    # It is still scrubbed, because the node owns it.
    assert "nvme0" in cfg.scrub_pools
    assert cfg.storage.tiers_for_pool("nvme0") == ["docker"]
    assert cfg.storage.tiers_for_pool("fast1") == ["fast", "docker"] or \
        cfg.storage.tiers_for_pool("fast1") == ["fast"]


def test_smb_cold_in_new_schema(tmp_path: Path):
    path = write(tmp_path, BASE + '\n[storage.cold]\nbackend = "smb"\npath = "/cold-storage"\n')
    cfg = load_config(path)
    assert cfg.slow_is_zfs is False
    assert cfg.cold_root == "/cold-storage"
    assert cfg.storage.cold.pools == ()


def test_new_schema_roundtrips_through_save(tmp_path: Path):
    cfg = make_cfg(fast_pools=["fast1", "fast2"], cold_pools=["cold1", "cold2"])
    path = save_config(cfg, tmp_path / "c.toml")
    assert load_config(path).storage.to_dict() == cfg.storage.to_dict()


def test_mergerfs_option_overrides_roundtrip(tmp_path: Path):
    path = write(tmp_path, BASE + (
        '\n[storage.fast]\nbackend = "mergerfs"\npools = ["fast1", "fast2"]\n'
        '\n[storage.fast.mergerfs]\nminfreespace_bytes = 1073741824\ncreate_policy = "epmfs"\n'
    ))
    cfg = load_config(path)
    assert cfg.storage.fast.mergerfs.minfreespace_bytes == 1073741824
    assert cfg.storage.fast.mergerfs.create_policy == "epmfs"
    saved = save_config(cfg, tmp_path / "out.toml")
    assert load_config(saved).storage.fast.mergerfs == cfg.storage.fast.mergerfs


def test_quota_headroom_override_roundtrips(tmp_path: Path):
    path = write(tmp_path, BASE + (
        '\n[storage.fast]\nbackend = "mergerfs"\npools = ["fast1", "fast2"]\n'
        'min_branch_headroom_bytes = 123456789\n'
    ))
    cfg = load_config(path)
    assert cfg.storage.fast.min_branch_headroom_bytes == 123456789
    saved = save_config(cfg, tmp_path / "out.toml")
    assert load_config(saved).storage.fast.min_branch_headroom_bytes == 123456789


# --------------------------------------------------------------------------- rejection


@pytest.mark.parametrize("body,fragment", [
    ('\n[storage.fast]\npools = ["fast1; rm -rf /"]\n', "invalid ZFS pool name"),
    ('\n[storage.fast]\npools = ["../../etc"]\n', "invalid ZFS pool name"),
    ('\n[storage.fast]\npools = ["mirror"]\n', "reserves the pool name"),
    ('\n[storage.fast]\npools = ["raidz2"]\n', "reserves"),
    ('\n[storage.fast]\npools = ["c0"]\n', "reserves"),
    ('\n[storage.fast]\npools = ["1fast"]\n', "invalid ZFS pool name"),
    ('\n[storage.fast]\nbackend = "smb"\npools = ["fast1"]\n', "backend must be one of"),
    ('\n[storage.cold]\nbackend = "nfs"\npools = ["c1"]\n', "backend must be one of"),
    ('\n[storage.fast]\nbackend = "zfs"\npools = ["fast1", "fast2"]\n', "backend 'zfs' supports"),
    ('\n[storage.fast]\nbackend = "mergerfs"\npools = ["fast:1", "fast2"]\n', "may not contain"),
    ('\n[storage.fast]\npools = ["fast1", "fast1"]\n', "listed twice"),
    ('\n[storage.fast]\nmount_root = "/fast/../etc"\n', "normalized"),
    ('\n[storage.fast]\nmount_root = "relative"\n', "absolute path"),
    ('\n[storage.fast]\nmount_root = "/"\n', "filesystem root"),
    ('\n[storage.fast.mergerfs]\ncreate_policy = "; rm -rf /"\n', "create policy must be one of"),
    ('\n[storage.fast.mergerfs]\nmoveonenospc = "yes"\n', "moveonenospc"),
    ('\n[storage.fast.mergerfs]\nminfreespace_bytes = -1\n', "minfreespace"),
    ('\n[storage.fast.mergerfs]\nallow_other = "sure"\n', "booleans"),
    ('\n[storage.fast.mergerfs]\nnonsense = 1\n', "unknown mergerfs option"),
    ('\n[storage.fast]\nnonsense = 1\n', "unknown key"),
    ('\n[storage.nope]\npools = ["x"]\n', "unknown section"),
    ('\n[storage.docker]\npool = "bad name"\n', "invalid ZFS pool name"),
    ('\n[storage.docker]\ndataset = "../escape"\n', "invalid docker dataset name"),
    ('\n[storage.docker]\nquota_gb = -5\n', "quota_gb"),
    ('\n[storage.docker]\ndata_root = "/fast/docker"\n', "must not overlap"),
    ('\n[storage.docker]\ndataset = "labs"\n', "collides"),
])
def test_invalid_storage_config_is_rejected(tmp_path: Path, body: str, fragment: str):
    path = write(tmp_path, BASE + body)
    with pytest.raises(ValueError, match=fragment):
        load_config(path)


def test_a_pool_may_not_back_two_tiers(tmp_path: Path):
    path = write(tmp_path, BASE + (
        '\n[storage.fast]\npools = ["shared"]\n\n[storage.cold]\npools = ["shared"]\n'
    ))
    with pytest.raises(ValueError, match="may only back one tier|only one tier"):
        load_config(path)


def test_unknown_agent_key_is_rejected(tmp_path: Path):
    with pytest.raises(ValueError, match="unknown key"):
        load_config(write(tmp_path, BASE + 'wat = 1\n'))


def test_mergerfs_mount_root_may_not_be_inside_branch_root():
    with pytest.raises(StorageConfigError, match="must not live inside branch_root"):
        make_cfg(fast_pools=["f1", "f2"], fast_mount_root="/mnt/lab-storage/fast")


def test_fast_and_cold_mount_roots_may_not_be_nested(tmp_path: Path):
    path = write(tmp_path, BASE + (
        '\n[storage.fast]\nmount_root = "/data"\n'
        '\n[storage.cold]\nmount_root = "/data/cold"\n'
    ))
    with pytest.raises(ValueError, match="must not overlap"):
        load_config(path)


def test_unreadable_config_says_to_use_sudo(tmp_path: Path):
    path = write(tmp_path, BASE)
    path.chmod(0o000)
    try:
        if os.geteuid() == 0:
            pytest.skip("root reads 0000 files regardless of mode")
        with pytest.raises(PermissionError, match="Re-run the command with sudo"):
            load_config(path)
    finally:
        path.chmod(0o600)
