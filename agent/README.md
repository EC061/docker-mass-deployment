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
- `lab-agent doctor` — check that zfs, docker, the `fast`/`slow` pools, and nvidia-smi are present.

## Cold storage backend

By default the slow (cold-storage) tier is a local ZFS pool (`slow`). To use an external SMB/CIFS
mount instead — e.g. a shared NAS — mount the share first, then pass on `install`:

```
--slow-backend smb --slow-path /mnt/cold [--slow-shared]
```

On the SMB backend the cold tier uses directories (not datasets): quotas are not enforced and the
share is never scrubbed (it is the share owner's responsibility). `--slow-shared` marks a share
mounted on more than one node; each node only manages its own labs' sub-directories.

## ZFS scrubs

The controller schedules scrubs (Settings → ZFS scrub) and sends `node.scrub` tasks; the agent kicks
off `zpool scrub` on each ZFS pool it owns and reports per-pool scrub status (state, in-progress,
error count) back in its heartbeat telemetry, so the controller can alert admins when errors appear.
