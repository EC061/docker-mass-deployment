# Lab Manager

A multi-node manager for ZFS-backed, GPU-equipped lab servers. A central web **controller** manages
**labs** (one shared SSH container per lab, owned by a PI) across many machines; a lightweight
**agent** on each server does the actual `zfs` / `docker` / `nvidia-smi` work.

- Per-lab fast (NVMe) + slow ZFS quotas, **changeable live** from the web UI.
- Per-student `~/scratch` (fast) and `~/cold-storage` (slow), added/removed with one click or by CSV.
- Idle-GPU-process killer (warn-then-kill, with whitelist) that emails the owning student.
- Scheduled **ZFS scrubs** on a controller-set interval; scrub errors raise an admin alert.
- Cold (slow) storage can be a local ZFS pool **or an SMB mount of another node's slow pool**, so
  containers on two nodes share the same cold data. The owning ZFS node does all monitoring.
- External SMTP, WebDAV backups, GPU policy, and quota defaults — all configured in the web UI.
- Centralized logs and log-level admin alerts.

```
        ┌──────────── Controller (web UI + API + WebSocket hub) ────────────┐
        │  Next.js · SQLite(WAL) · honker queue · SMTP · WebDAV backup       │
        └───────────────────────────────┬───────────────────────────────────┘
                                         │  WSS (agent dials in, token auth)
              ┌──────────────────────────┼──────────────────────────┐
          ┌───▼────┐                 ┌────▼───┐                  ┌────▼───┐
          │ agent  │                 │ agent  │                  │ agent  │   (Python, one per server)
          │ gpu-01 │                 │ gpu-02 │                  │ gpu-03 │
          └────────┘                 └────────┘                  └────────┘
       fast + slow ZFS pools, GPUs · docker on the zfs storage driver
```

A lab is **pinned to one node** (its storage lives on that machine's pools).

---

## 1. Node host prep (run once per GPU server)

The manager does **not** create ZFS pools or install Docker/NVIDIA — you do that once per node. The
agent assumes `fast` and `slow` pools already exist and Docker uses the `zfs` storage driver.

### 1.1 Create the pools

Replace the device names with your disks. The agent expects pools named `fast` (NVMe) and `slow`.

```bash
# Fast NVMe pool (example: a single NVMe; use mirror/raidz for redundancy).
sudo zpool create -o ashift=12 fast /dev/nvme0n1

# Slow bulk pool.
sudo zpool create -o ashift=12 slow /dev/sda

# Datasets the agent uses (it creates per-lab children under these automatically).
sudo zfs create fast/labs
sudo zfs create slow/labs
sudo zfs create fast/docker     # Docker's zfs storage driver lives here
```

### 1.2 Dataset properties

```bash
# atime ON so the old-file scanner can report truly-unused files (NOT relatime/noatime).
sudo zfs set atime=on fast/labs slow/labs
sudo zfs set compression=lz4 fast slow
sudo zfs set xattr=sa fast slow
# Larger records suit bulk/cold data; default (128K) is fine for fast scratch.
sudo zfs set recordsize=1M slow
```

### 1.3 Point Docker at the zfs storage driver

```bash
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "storage-driver": "zfs",
  "data-root": "/fast/docker"
}
JSON
sudo systemctl restart docker
docker info | grep -i 'Storage Driver'   # should print: Storage Driver: zfs
```

> Per-student scratch/cold datasets are bind-mounted into the lab container with `rshared`
> propagation so they appear live. Make the ZFS mounts shared once per boot:
> `sudo mount --make-rshared /fast && sudo mount --make-rshared /slow`.

### 1.4 NVIDIA container toolkit (for GPU labs)

Install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html),
then verify:

```bash
nvidia-smi
docker info | grep -i runtimes   # should list: nvidia
```

### 1.5 Install the agent

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh        # if uv is not present
# Pin to a released tag (not #main) and install with the shipped uv.lock so every node runs the same
# audited code + dependency set (I-02). Replace v1.0.0 with the tag you intend to deploy.
sudo uvx --locked --from "git+https://github.com/EC061/docker-mass-deployment@v1.0.0#subdirectory=agent" \
    lab-agent install --controller wss://CONTROLLER_HOST:8443/agent
```

`lab-agent install` writes `/etc/lab-agent/config.toml` and a systemd unit (`lab-agent.service`) that
starts on boot and reconnects automatically.

**Provision the node's token:** in the controller UI go to **Nodes → Provision token**, then run the
printed command on the node to apply it and restart the agent:

```bash
sudo lab-agent set-token <TOKEN-FROM-UI>
```

Each node has its own token; the controller only accepts allow-listed nodes (so a stolen token can't
impersonate another node). Check readiness any time with `lab-agent doctor`.

### 1.6 Sharing cold storage between two nodes over SMB (optional)

When two nodes need their containers to see the **same** cold data, one node owns the slow ZFS pool
and the other mounts it over SMB:

- **Owner node** — installed normally (zfs backend). It owns the `slow` pool, creates the cold
  datasets, enforces quotas, runs old-file scans, scrubs it, and reports its usage. Export the pool
  over SMB (e.g. Samba) so the other node can mount it.
- **Client node** — mounts that export (via `/etc/fstab` or `systemd.mount`), then installs the
  agent with the SMB cold-storage backend so its containers bind-mount the shared data:

```bash
sudo uvx --locked --from "git+https://github.com/EC061/docker-mass-deployment@v1.0.0#subdirectory=agent" \
    lab-agent install --controller wss://CONTROLLER_HOST:8443/agent \
    --slow-backend smb --slow-path /mnt/cold --slow-shared
# then provision + apply the token as above: sudo lab-agent set-token <TOKEN-FROM-UI>
```

- `--slow-path` is where the share is mounted; labs live under `<slow-path>/labs/...`.
- `--slow-shared` marks the share as mounted on more than one node, so the client only ever touches
  its own labs' sub-directories (guarded deletes).
- The client is a **pure consumer**: it makes the per-lab/per-student directories its containers
  bind-mount, but does **no** quota, usage telemetry, old-file scan, or scrub for cold storage — the
  owner node does all of that for the same data. The fast tier is still a local ZFS pool either way.

---

## 2. Deploy the controller

The controller is a long-lived Node process (Next.js + WebSocket hub); it cannot run serverless.

```bash
cd controller
cp .env.example .env     # set SIGNUP_TOKEN, AGENT_TOKEN, SESSION_SECRET (no defaults — required)
docker compose up -d     # from the repo root (uses controller/Dockerfile); the supported deploy
```

`npm run dev` (below, under Development) is for local hacking only — never a production deploy.
All three secrets are mandatory in every environment and `SESSION_SECRET` must be ≥ 32 characters;
generate them with `openssl rand -hex 32`.

Env vars (controller bootstrap only — everything else is set in the UI):

| Var | Purpose |
|---|---|
| `SIGNUP_TOKEN` | required to register an admin on the signup page |
| `AGENT_TOKEN` | shared token every agent presents when it connects |
| `SESSION_SECRET` | signs admin session cookies |
| `DB_PATH` | SQLite path (mount a volume here in Docker) |
| `PORT` | HTTP + agent-WebSocket port (default 8443) |

The published image is `ghcr.io/ec061/lab-controller` (built by CI on tags/main).

### First login

Open the controller, go to **Sign up**, and register the first admin using the `SIGNUP_TOKEN`. Then
open **Settings** and configure:

- **Email (external SMTP)** — host/port/user/pass/from; click *Send test*.
- **WebDAV backup** — URL/credentials, retention, and backup interval.
- **GPU idle policy** — enable, thresholds, grace, whitelist; *Save & push to nodes*.
- **Storage & ports** — default fast/slow quotas, SSH port range, old-file threshold.
- **ZFS scrub** — enable scheduled scrubs and set the interval (days); *Scrub now* runs one
  immediately. Only ZFS-capable nodes are scrubbed; SMB cold storage is skipped.
- **Alerts & logs** — alert level (WARN/ERROR), dedup window, quota alert %, log retention.

---

## 3. Day-to-day use

- **Nodes** — see which servers are online, their GPUs, pools, cold-storage backend (ZFS or SMB),
  latest scrub status, and any host-prep issues.
- **Labs** — create a lab (pick its node, fast/slow quota, base image, and container options). Container
  options (CPU/RAM/shared-memory/image-size quota/restart) are **set once at creation**; changing them
  needs *Recreate container* (data is preserved). All GPUs are always attached. Quotas are editable
  **live**. The lab detail page shows storage-over-time, members, and old-file counts (*Rescan now*).
- **Students** — add a student to a lab (a password is generated and emailed; shown once in the UI) or
  bulk-import from CSV with a configurable column mapping. Removing a student optionally deletes their
  data.
- **GPU** — live GPU processes per node and recent idle-kill events.
- **Logs** — filter by level/node/search; click a task to trace its lifecycle.

### Build a lab base image

A default Ubuntu+SSH image is in [image/](image/):

```bash
docker build -t custom-ssh ./image     # run on each node, or push to a registry the nodes can pull
```

Use any image name in the lab create form; it must run an SSH server and allow `useradd`.

---

## 4. Development

```bash
# Controller
cd controller && npm install
npm run dev         # tsx watch server.ts
npm run lint && npm run typecheck && npm test && npm run build

# Agent
cd agent && uv venv && uv pip install -e ".[dev]"
.venv/bin/ruff check src tests && .venv/bin/pytest
```

CI (GitHub Actions) runs lint/typecheck/tests/build for both, and publishes the controller image to
GHCR on tags/main.

## License

MIT — see [LICENSE](LICENSE).
