from lab_agent import paths
from lab_agent.config import AgentConfig


def _cfg(**kw):
    base = dict(controller_url="ws://x", token="t", node_name="n")
    base.update(kw)
    return AgentConfig(**base)


def test_zfs_dataset_names_use_pool_roots():
    cfg = _cfg(fast_pool="fast", slow_pool="slow")
    assert paths.lab_fast(cfg, "bio") == "fast/labs/bio"
    assert paths.lab_slow(cfg, "bio") == "slow/labs/bio"
    assert paths.lab_fast_shared(cfg, "bio") == "fast/labs/bio/shared"
    assert paths.lab_slow_shared(cfg, "bio") == "slow/labs/bio/shared"
    assert paths.lab_fast_users(cfg, "bio") == "fast/labs/bio/users"
    assert paths.lab_slow_users(cfg, "bio") == "slow/labs/bio/users"


def test_user_dataset_names():
    cfg = _cfg(fast_pool="fast", slow_pool="slow")
    assert paths.user_scratch(cfg, "bio", "alice") == "fast/labs/bio/users/alice"
    assert paths.user_cold(cfg, "bio", "alice") == "slow/labs/bio/users/alice"


def test_custom_pool_names_propagate():
    cfg = _cfg(fast_pool="nvme0", slow_pool="rust1")
    assert paths.lab_fast(cfg, "ml") == "nvme0/labs/ml"
    assert paths.user_cold(cfg, "ml", "bob") == "rust1/labs/ml/users/bob"


def test_cold_paths_are_filesystem_paths_under_cold_root():
    cfg = _cfg(slow_backend="smb", slow_path="/mnt/cold")
    assert paths.cold_lab(cfg, "bio") == "/mnt/cold/labs/bio"
    assert paths.cold_lab_shared(cfg, "bio") == "/mnt/cold/labs/bio/shared"
    assert paths.cold_lab_users(cfg, "bio") == "/mnt/cold/labs/bio/users"
    assert paths.cold_user(cfg, "bio", "alice") == "/mnt/cold/labs/bio/users/alice"


def test_cold_paths_mirror_zfs_layout_so_controller_parser_works():
    # The controller parses "…/labs/<lab>[/users/<u>]"; the SMB layout must match.
    cfg = _cfg(slow_backend="smb", slow_path="/srv/share/")  # trailing slash stripped via cold_root
    assert paths.cold_lab(cfg, "bio") == "/srv/share/labs/bio"
    assert paths.cold_user(cfg, "bio", "u") == "/srv/share/labs/bio/users/u"
