# lab-agent

Node agent for the multi-node lab manager. One instance runs on each GPU server. It dials home to
the controller over an outbound WebSocket and executes all local `zfs` / `docker` / `useradd` /
`nvidia-smi` work. See the repository root `README.md` for full host-prep and install instructions.

## Quick install (per node)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # if uv is not already present
uvx --from git+https://github.com/EC061/docker-mass-deployment#subdirectory=agent \
    lab-agent install --controller wss://CONTROLLER_IP:PORT --token AGENT_TOKEN
```

`lab-agent install` writes `/etc/lab-agent/config.toml` and a systemd unit (`lab-agent.service`)
so the agent starts on boot and reconnects automatically.

## Commands

- `lab-agent run` — run the agent in the foreground (used by the systemd unit).
- `lab-agent install --controller URL --token TOKEN [--node-name NAME]` — write config + systemd unit.
- `lab-agent doctor` — check that zfs, docker, the `fast`/`slow` pools, nvidia-smi, the
  `sysbox-runc` runtime, and the NVIDIA CDI spec are present (and show each lab's last apt-patch time).

## Cold storage backend

By default the slow (cold-storage) tier is a local ZFS pool (`slow`). To share cold storage with
another node, one node owns the ZFS pool and exports it over SMB; this node mounts that export and
runs the SMB backend so its containers see the same data. Mount the share first, then on `install`:

```
--slow-backend smb --slow-path /mnt/cold [--slow-shared]
```

On the SMB backend this node is a **pure client**: it creates the per-lab/per-student directories
its containers bind-mount, but does no quota, usage telemetry, old-file scan, or scrub for cold
storage — the node that owns the ZFS pool does all of that for the same data. `--slow-shared` marks
a share mounted on more than one node; this node only manages its own labs' sub-directories.

## ZFS scrubs

The controller schedules scrubs (Settings → ZFS scrub) and sends `node.scrub` tasks; the agent kicks
off `zpool scrub` on each ZFS pool it owns and reports per-pool scrub status (state, in-progress,
error count) back in its heartbeat telemetry, so the controller can alert admins when errors appear.
