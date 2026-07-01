# lab-agent

The node agent mounts `/fast/<lab>` at container `/home` and `/cold-storage/<lab>` at container
`/cold-storage`, provisions standard `runc` lab containers and exact-ID
student accounts, explicit storage telemetry, NVIDIA CDI devices, and node health/maintenance tasks.

On an SMB client, `/cold-storage` must be an active mount of the owner node's cold tree. The same
numeric Docker user-namespace mapping is required on both nodes so either placement can safely and
idempotently converge student-directory ownership.

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
