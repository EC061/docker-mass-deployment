from lab_agent import containerops, labops
from lab_agent.config import AgentConfig
from lab_agent.executors import zfs


def _cfg():
    return AgentConfig(controller_url="ws://x", token="t", fast_pool="fast", slow_pool="slow",
                       node_name="n1")


def _patch_zfs(monkeypatch):
    created: list[tuple[str, int | None]] = []
    quotas: list[tuple[str, int | None]] = []
    destroyed: list[str] = []

    def create_dataset(name, *, quota_bytes=None, create_parents=True, mountpoint=None):
        created.append((name, quota_bytes))

    def set_quota(dataset, quota_bytes):
        quotas.append((dataset, quota_bytes))

    def destroy_dataset(name, *, recursive=True):
        destroyed.append(name)

    def get_usage(dataset):
        return zfs.Usage(dataset, 0, None, None)

    monkeypatch.setattr(labops.zfs, "create_dataset", create_dataset)
    monkeypatch.setattr(labops.zfs, "set_quota", set_quota)
    monkeypatch.setattr(labops.zfs, "destroy_dataset", destroy_dataset)
    monkeypatch.setattr(labops.zfs, "get_usage", get_usage)
    monkeypatch.setattr(labops.zfs, "get_mountpoint", lambda ds: "/fast/bio")
    monkeypatch.setattr(labops.coldstore, "lab_mount", lambda cfg, lab: "/cold/bio")
    monkeypatch.setattr("lab_agent.executors.coldfs.ensure_owned_dir", lambda *a, **k: None)
    # Container creation needs Docker/ZFS mountpoints — stub it for the storage-focused tests.
    monkeypatch.setattr(containerops, "ensure_container", lambda cfg, lab, params: "container-id")
    monkeypatch.setattr(containerops, "assert_node_ready", lambda cfg: None)
    return created, quotas, destroyed


def test_create_lab_provisions_one_dataset_per_tier(monkeypatch):
    created, _quotas, _ = _patch_zfs(monkeypatch)
    result, _logs = labops.create_lab(_cfg(), {"lab": "bio", "fast_quota_bytes": 2000, "slow_quota_bytes": 3000})
    names = [n for n, _ in created]
    assert "fast/labs/bio" in names
    assert "slow/labs/bio" in names
    assert names == ["fast/labs/bio", "slow/labs/bio"]
    # Parent datasets get the quota.
    assert ("fast/labs/bio", 2000) in created
    assert ("slow/labs/bio", 3000) in created
    assert result["lab"] == "bio"


def test_set_lab_quota_live(monkeypatch):
    _created, quotas, _ = _patch_zfs(monkeypatch)
    labops.set_lab_quota(_cfg(), {"lab": "bio", "fast_quota_bytes": 4000})
    assert ("fast/labs/bio", 4000) in quotas
    # slow not touched
    assert all(d != "slow/labs/bio" for d, _ in quotas)


def test_destroy_lab_removes_both_roots(monkeypatch):
    _created, _quotas, destroyed = _patch_zfs(monkeypatch)
    from lab_agent.executors import docker

    monkeypatch.setattr(docker, "remove_container", lambda name: None)
    labops.destroy_lab(_cfg(), {"lab": "bio"})
    assert "fast/labs/bio" in destroyed
    assert "slow/labs/bio" in destroyed


def test_destroy_lab_removes_container_before_datasets(monkeypatch):
    # The container must be removed first; otherwise its bind mounts keep the datasets busy and
    # `zfs destroy -r` fails ("dataset is busy"). Assert remove_container runs before destroy.
    _created, _quotas, _destroyed = _patch_zfs(monkeypatch)
    from lab_agent.executors import docker

    order: list[str] = []
    monkeypatch.setattr(docker, "remove_container", lambda name: order.append(f"rm:{name}"))
    monkeypatch.setattr(labops.zfs, "destroy_dataset",
                        lambda name, *, recursive=True: order.append(f"destroy:{name}"))
    labops.destroy_lab(_cfg(), {"lab": "bio"})
    assert order[0] == "rm:bio-n1"
    assert any(o.startswith("destroy:") for o in order[1:])
