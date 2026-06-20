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
