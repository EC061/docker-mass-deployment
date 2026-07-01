from pathlib import Path

import pytest

from lab_agent.config import AgentConfig, load_config, save_config


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


def test_derived_dataset_paths():
    cfg = AgentConfig(controller_url="ws://x", token="t", fast_pool="nvme", slow_pool="bulk")
    assert cfg.labs_fast_root == "nvme/labs"
    assert cfg.labs_slow_root == "bulk/labs"


def test_missing_config_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        load_config(tmp_path / "nope.toml")


def test_saved_config_is_owner_only(tmp_path: Path):
    cfg = AgentConfig(controller_url="ws://x", token="t")
    path = save_config(cfg, tmp_path / "c.toml")
    assert (path.stat().st_mode & 0o777) == 0o600


def test_default_slow_backend_is_zfs():
    cfg = AgentConfig(controller_url="ws://x", token="t")
    assert cfg.slow_is_zfs is True
    assert cfg.scrub_pools == [cfg.fast_pool, cfg.slow_pool]


def test_smb_backend_roundtrip_and_scrub_pools(tmp_path: Path):
    cfg = AgentConfig(
        controller_url="ws://x",
        token="t",
        slow_backend="smb",
        slow_path="/mnt/cold/",
    )
    path = save_config(cfg, tmp_path / "c.toml")
    loaded = load_config(path)
    assert loaded.slow_backend == "smb"
    assert loaded.slow_is_zfs is False
    # SMB cold storage is never scrubbed -> only the fast pool is scrubbable.
    assert loaded.scrub_pools == ["fast"]
    # cold_root strips the trailing slash.
    assert loaded.cold_root == "/mnt/cold"


def test_invalid_slow_backend_rejected(tmp_path: Path):
    cfg = AgentConfig(controller_url="ws://x", token="t", slow_backend="nfs")
    path = save_config(cfg, tmp_path / "c.toml")
    with pytest.raises(ValueError):
        load_config(path)
