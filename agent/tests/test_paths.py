import pytest
from storagehelp import make_cfg as cfg

from lab_agent import paths


def test_flat_dataset_and_mount_paths():
    c = cfg(fast_pools=["nvme"], cold_pools=["bulk"], fast_mount_root="/fast")
    assert paths.lab_fast(c, "bio") == "nvme/labs/bio"
    assert paths.lab_slow(c, "bio") == "bulk/labs/bio"
    assert paths.fast_mount(c, "bio") == "/fast/bio"
    assert paths.cold_mount(c, "bio") == "/cold-storage/bio"


def test_multi_pool_paths_keep_one_logical_mount_per_tier():
    # Two pools -> one dataset per pool, mounted out of container sight, and the SAME logical path.
    c = cfg(fast_pools=["fast1", "fast2"], cold_pools=["cold1", "cold2"])
    assert paths.lab_branch_datasets(c, "fast", "bio") == ["fast1/labs/bio", "fast2/labs/bio"]
    assert paths.lab_branch_datasets(c, "cold", "bio") == ["cold1/labs/bio", "cold2/labs/bio"]
    assert paths.fast_mount(c, "bio") == "/fast/bio"
    assert paths.cold_mount(c, "bio") == "/cold-storage/bio"
    assert c.storage.fast.branch_mount("fast2", "bio") == "/mnt/lab-storage/fast2/labs/bio"
    assert paths.user_branch_datasets(c, "fast", "bio", "alice") == [
        "fast1/labs/bio/alice", "fast2/labs/bio/alice",
    ]


def test_smb_paths_have_no_shared_or_users_layer():
    c = cfg(cold_backend="smb", slow_path="/srv/cold")
    assert paths.cold_lab(c, "bio") == "/srv/cold/bio"
    assert paths.cold_user(c, "bio", "alice") == "/srv/cold/bio/alice"


def test_invalid_lab_name_is_rejected():
    with pytest.raises(ValueError):
        paths.lab_fast(cfg(), "../escape")
