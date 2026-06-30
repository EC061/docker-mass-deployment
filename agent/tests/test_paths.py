import pytest

from lab_agent import paths
from lab_agent.config import AgentConfig


def cfg(**kw):
    return AgentConfig(controller_url="ws://x", token="t", **kw)


def test_flat_dataset_and_mount_paths():
    c = cfg(fast_pool="nvme", slow_pool="bulk", fast_mount_root="/fast")
    assert paths.lab_fast(c, "bio") == "nvme/labs/bio"
    assert paths.lab_slow(c, "bio") == "bulk/labs/bio"
    assert paths.fast_mount(c, "bio") == "/fast/bio"


def test_smb_paths_have_no_shared_or_users_layer():
    c = cfg(slow_backend="smb", slow_path="/srv/cold/")
    assert paths.cold_lab(c, "bio") == "/srv/cold/labs/bio"
    assert paths.cold_user(c, "bio", "alice") == "/srv/cold/labs/bio/alice"


def test_invalid_lab_name_is_rejected():
    with pytest.raises(ValueError):
        paths.lab_fast(cfg(), "../escape")
