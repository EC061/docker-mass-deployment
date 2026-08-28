# lab-agent

The node agent mounts `/fast/<lab>` at container `/home` and `/cold-storage/<lab>` at container
`/cold-storage`, provisions standard `runc` lab containers and exact-ID
student accounts, explicit storage telemetry, NVIDIA CDI devices, and node health/maintenance tasks.

On an SMB client, `/cold-storage` must be an active mount of the owner node's cold tree. The same
numeric Docker user-namespace mapping is required on both nodes so either placement can safely and
idempotently converge student-directory ownership.

Storage configuration supports the legacy `[agent] fast_pool/slow_pool/slow_backend` keys and the
generic schema below. Loading legacy values produces the same single-pool model; the next config
save rewrites it in the new format without touching pools or data.

```toml
[storage.fast]
backend = "mergerfs"
pools = ["fast1", "fast2"]
mount_root = "/fast"
branch_root = "/mnt/lab-storage"

[storage.cold]
backend = "mergerfs" # also zfs or smb
pools = ["cold1", "cold2"]
mount_root = "/cold-storage"

[storage.docker]
pool = "fast1"
dataset = "docker"
data_root = "/var/lib/docker"
quota_gb = 1024
```

Use `lab-agent storage status --json`, `storage devices`, `storage mount`, `storage add-pool`, and
`storage rebalance` for controller-independent inspection/recovery. Pool/tier topology is local and
safety-critical at boot; the controller drives changes and per-lab quotas, and hardware health is
always discovered read-only. See `HOST_PREPARATION.md` for expansion and degraded recovery.

Install and prepare a node:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh

REPO="git+https://github.com/EC061/docker-mass-deployment.git#subdirectory=agent"

sudo uvx --from "$REPO" lab-agent install
sudo uvx --from "$REPO" lab-agent edit-config
sudo uvx --from "$REPO" lab-agent host-prepare
sudo uvx --from "$REPO" lab-agent start
```

After a lab and student have been provisioned, run `sudo lab-agent doctor`. Health is critical if
Docker userns remapping, the real unprivileged-bubblewrap smoke test, `nvcc --version`, NVML/CDI, ZFS, or
the configured SMB mount fails.

Development checks:

```bash
uv run --extra dev ruff check src tests
uv run --extra dev pytest -q
```
