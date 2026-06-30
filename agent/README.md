# lab-agent

The node agent provisions flattened fast/cold storage, standard `runc` lab containers, exact-ID
student accounts, explicit storage telemetry, NVIDIA CDI devices, and node health/maintenance tasks.

Install and prepare a node:

```bash
sudo python3 -m pip install .
sudo lab-agent install
sudo lab-agent edit-config
sudo lab-agent host-prepare
sudo lab-agent start
```

After a lab and student have been provisioned, run `sudo lab-agent doctor`. Health is critical if
Docker userns remapping, bubblewrap namespaces, the real `codex sandbox linux -- true` smoke test,
NVML/CDI, ZFS, or the configured SMB mount fails.

Development checks:

```bash
uv run --extra dev ruff check src tests
uv run --extra dev pytest -q
```
