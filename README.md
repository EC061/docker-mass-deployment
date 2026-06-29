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
# (Docker's own storage is set up separately in step 1.3.)
```

### 1.2 Dataset properties

```bash
sudo zfs set compression=lz4 fast slow
sudo zfs set xattr=sa fast slow
# Larger records suit bulk/cold data; default (128K) is fine for fast scratch.
sudo zfs set recordsize=1M slow
```

### 1.3 Docker storage: overlay2 on an xfs zvol (recommended)

Lab containers run under Sysbox, and **Sysbox cannot use Docker's `zfs` storage driver on a kernel
without `shiftfs`** — e.g. stock Ubuntu kernels ≥ 6.8, which dropped shiftfs in favour of ID-mapped
mounts. With the `zfs` driver a container's rootfs is a zfs dataset, and `sysbox-mgr` rejects it
with `unknown fs` (its filesystem table has no entry for ZFS), so no lab container can start.

Run Docker on the **`overlay2`** driver instead, backed by an **xfs filesystem on a ZFS zvol carved
from the fast pool**. Docker's layers still live on the NVMe, Sysbox gets the overlayfs rootfs it
supports natively, and `--storage-opt size=` (the per-lab writable-layer quota) still works because
xfs supports project quotas.

```bash
# A thin (sparse) zvol on the fast pool for Docker's data-root (grow later with `zfs set volsize`).
sudo zfs create -s -V 1T fast/dockervol
# xfs with ftype=1 (required by overlay2) + project quota (required by --storage-opt size).
sudo mkfs.xfs -m crc=1 -L docker /dev/zvol/fast/dockervol
sudo mkdir -p /fast/docker
sudo mount -o prjquota /dev/zvol/fast/dockervol /fast/docker

# Persist the mount, order it before docker, and make docker require it. nofail keeps boot alive if
# the zvol is ever missing; RequiresMountsFor stops docker starting on the wrong (empty) directory.
echo '/dev/zvol/fast/dockervol /fast/docker xfs prjquota,nofail,x-systemd.requires=zfs-volumes.target,x-systemd.before=docker.service 0 0' | sudo tee -a /etc/fstab
sudo mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nRequiresMountsFor=/fast/docker\n' | sudo tee /etc/systemd/system/docker.service.d/10-data-root-mount.conf
sudo systemctl daemon-reload

sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "storage-driver": "overlay2",
  "data-root": "/fast/docker"
}
JSON
sudo systemctl restart docker
docker info | grep -iE 'Storage Driver|Backing Filesystem'   # overlay2 / xfs
```

> **ZFS storage driver — only on kernels with a working `shiftfs`.** Some older Ubuntu HWE kernels
> still ship shiftfs; there the native `zfs` driver works under Sysbox. Use `zfs create fast/docker`,
> `sudo zfs set acltype=posixacl xattr=sa fast/docker`, and a `daemon.json` with
> `"storage-driver": "zfs"` instead of the zvol above. `lab-agent doctor` accepts either driver
> (for overlay2 it additionally checks the backing filesystem is xfs). On shiftfs-less kernels the
> `zfs` driver fails to launch lab containers, so prefer overlay2.

> **Migrating an existing Docker root.** Changing `data-root` (or the storage driver) does **not**
> move existing data — Docker just starts empty at the new path, orphaning the old images/containers
> under `/var/lib/docker`. On a node that has already run Docker, migrate before restarting:
>
> ```bash
> sudo systemctl stop docker docker.socket           # stop the engine and its socket
> sudo rsync -aHAX --info=progress2 /var/lib/docker/ /fast/docker/   # copy data onto the new root
> # ...write /etc/docker/daemon.json as above, then:
> sudo systemctl start docker
> docker info | grep -iE 'Storage Driver|Docker Root Dir'   # overlay2, /fast/docker
> docker images && docker ps -a                      # confirm images/containers survived
> sudo mv /var/lib/docker /var/lib/docker.old         # remove only after you've verified
> ```
>
> Layers are only reusable when the storage driver is unchanged (overlay2 → overlay2). When you also
> switch drivers, the old layers are **not** reusable — on a clean node just write `daemon.json` and
> restart; otherwise `docker save` the images you care about and `docker load` them after the switch.

> Per-student scratch/cold datasets are bind-mounted into the lab container with `rshared`
> propagation so they appear live. Make the ZFS mounts shared once per boot:
> `sudo mount --make-rshared /fast && sudo mount --make-rshared /slow`.

### 1.4 NVIDIA container toolkit + CDI (for GPU labs)

Install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
(**≥ 1.17**), then generate a **CDI** spec. Lab containers run under the Sysbox runtime (next step),
so GPUs are attached with the runtime-agnostic CDI device `nvidia.com/gpu=all` rather than the
`nvidia` runtime (which cannot be combined with `sysbox-runc`):

```bash
nvidia-smi
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
nvidia-ctk cdi list | grep nvidia.com/gpu        # should list nvidia.com/gpu=all
```

> Regenerate the spec after a driver upgrade (enable the `nvidia-cdi-refresh` service if your
> toolkit ships it, or re-run the command). `lab-agent doctor` flags a node that has GPUs but no
> CDI spec — without it, GPU labs launch GPU-less rather than fall back to an incompatible runtime.

### 1.5 Sysbox runtime (nested Docker, host-isolated)

Lab containers run under [Sysbox CE](https://github.com/nestybox/sysbox) (**≥ 0.7.0**) so users get
real Docker **inside** their container without `--privileged`. Sysbox's user-namespace remap maps
container-root (and therefore per-user `sudo`) to an **unprivileged host UID**, so neither the inner
Docker daemon nor sudo is a path to host root — that is what makes granting sudo safe on a shared
host.

```bash
# Install Sysbox CE (see upstream for the current .deb); it registers the sysbox-runc runtime.
docker info | grep -i runtimes   # should now list: runc sysbox-runc (and nvidia on GPU nodes)
```

Requirements: a recent Ubuntu LTS (22.04/24.04; shiftfs or kernel ≥ 5.19 idmapped mounts).

> **Pin Docker to a Sysbox-compatible version.** Sysbox CE 0.7.0 does **not** support containerd 2.x
> / Docker ≥ 28 — lab containers fail to create with `namespace {"time" ""} does not exist`. Install
> Docker from the **27.x** line on **containerd 1.7.x** and hold the packages so an `apt upgrade`
> can't silently break the node:
>
> ```bash
> sudo apt-get install -y --allow-downgrades \
>     docker-ce=5:27.5.1-1~ubuntu.24.04~noble \
>     docker-ce-cli=5:27.5.1-1~ubuntu.24.04~noble \
>     containerd.io=1.7.29-1~ubuntu.24.04~noble
> sudo apt-mark hold docker-ce docker-ce-cli containerd.io
> ```

> **Validate once before fleet rollout.** With the recommended overlay2 setup from step 1.3:
> `docker run --rm --runtime=sysbox-runc --storage-opt size=20g custom-ssh` should start and enforce
> the writable-layer quota, and on GPU nodes
> `docker run --rm --runtime=sysbox-runc --device nvidia.com/gpu=all custom-ssh nvidia-smi` should
> see the GPUs. (On a kernel using the `zfs` Docker driver, this is the step that fails with
> `unknown fs` — see step 1.3.)

### 1.6 Install the agent

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh        # if uv is not present
sudo uvx --from "git+https://github.com/EC061/docker-mass-deployment#subdirectory=agent" \
    lab-agent install
```

`lab-agent install` cleans up any previous install, installs lab-agent **persistently** with `uv tool
install` (so the systemd unit runs a stable on-disk binary, not the ephemeral `uvx` cache), writes a
config **template** at `/etc/lab-agent/config.toml` if none exists, and **enables but does NOT start**
the service. (For a reproducible, pinned deploy (I-02), add `--ref <tag>`, e.g.
`lab-agent install --ref v1.0.0`.)

Then fill in the config and start it. Get the node's token from the controller UI
(**Nodes → Provision token**):

```bash
sudo lab-agent edit-config     # opens the config in $EDITOR: set controller_url, token,
                               # node_name, and the cold-storage (slow_*) settings
sudo lab-agent start           # enable + start the service
sudo lab-agent doctor          # verify zfs/docker/nvidia/pools + service status
```

(`sudo lab-agent set-token <TOKEN-FROM-UI>` is a shortcut that writes just the token and restarts.)
Each node has its own token; the controller only accepts allow-listed nodes (so a stolen token can't
impersonate another node), and changing it takes effect immediately (the live socket is dropped).

**Upgrading the agent:** reinstall the newest code and restart in one step — the existing config and
token are preserved:

```bash
sudo lab-agent upgrade               # newest
sudo lab-agent upgrade --ref v1.1.0  # or pin to a released tag
```

### 1.7 Sharing cold storage between two nodes over SMB (optional)

When two nodes need their containers to see the **same** cold data, one node owns the slow ZFS pool
and the other mounts it over SMB:

- **Owner node** — installed normally (zfs backend). It owns the `slow` pool, creates the cold
  datasets, enforces quotas, scrubs it, and reports its usage. Export the pool over SMB (e.g. Samba)
  so the other node can mount it.
- **Client node** — mounts that export (via `/etc/fstab` or `systemd.mount`), then installs the
  agent with the SMB cold-storage backend so its containers bind-mount the shared data:

```bash
sudo uvx --from "git+https://github.com/EC061/docker-mass-deployment#subdirectory=agent" \
    lab-agent install
sudo lab-agent edit-config   # set slow_backend = "smb", slow_path = "/mnt/cold", slow_shared = true
                             # (plus controller_url / token / node_name)
sudo lab-agent start
```

The cold-storage **owner** node for an SMB client is selected in the controller UI (Nodes → cold
storage), not in the agent config. (`install` also accepts `--slow-backend smb --slow-path /mnt/cold
--slow-shared` to pre-seed the template when the config is first written.)

- `--slow-path` is where the share is mounted; labs live under `<slow-path>/labs/...`.
- `--slow-shared` marks the share as mounted on more than one node, so the client only ever touches
  its own labs' sub-directories (guarded deletes).
- The client is a **pure consumer**: it makes the per-lab/per-student directories its containers
  bind-mount, but does **no** quota, usage telemetry, or scrub for cold storage — the owner node
  does all of that for the same data. The fast tier is still a local ZFS pool either way.

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
| `CONTROLLER_DOMAIN` | public domain the controller is served at (host only, e.g. `lab.cs.uga.edu`). Required when a reverse proxy terminates TLS in front of it — otherwise Next.js rejects Server Action POSTs whose `Origin` ≠ internal `Host` (CSRF check). Comma-separated for multiple; `*.` wildcard label allowed; unset → same-origin only |

The published image is `ghcr.io/ec061/lab-controller` (built by CI on tags/main).

> **Data dir permissions (bind mounts).** The container runs as a non-root user (uid **10001**).
> The repo's compose uses a named volume (`controller-data`), which inherits that ownership
> automatically. If you instead bind-mount a host directory onto `/app/data` (e.g. a 1Panel/Portainer
> deploy mounting `./data`), that host dir is typically owned by `root` and the app can't write to it
> — boot fails with `SqliteError: unable to open database file` (`SQLITE_CANTOPEN`). Fix by giving the
> bind-mounted dir to uid 10001 once:
>
> ```bash
> sudo chown 10001:10001 ./data        # the host path mounted at /app/data
> docker compose restart controller
> ```

### First login

Open the controller, go to **Sign up**, and register the first admin using the `SIGNUP_TOKEN`. Then
open **Settings** and configure:

- **Email (external SMTP)** — host/port/user/pass/from; click *Send test*.
- **WebDAV backup** — URL/credentials, retention, and backup interval.
- **GPU idle policy** — enable, thresholds, grace, whitelist; *Save & push to nodes*.
- **Storage & ports** — default fast/slow quotas and SSH port range.
- **Per-student usage scan** — enable the nightly per-student `du` scan and set its hour/timezone
  (container-level usage is measured live every heartbeat and is not gated by this).
- **ZFS scrub** — enable scheduled scrubs and set the interval (days); *Scrub now* runs one
  immediately. Only ZFS-capable nodes are scrubbed; SMB cold storage is skipped.
- **Alerts & logs** — alert level (WARN/ERROR), dedup window, quota alert %, log retention.

---

## 3. Day-to-day use

- **Nodes** — see which servers are online, their GPUs, pools, cold-storage backend (ZFS or SMB),
  latest scrub status, and any host-prep issues. Provision/rotate a per-node token, **revoke** a node
  (its token stops working but its row and history stay), or **delete** it outright (removed only when
  no labs are still pinned to it).
- **Labs** — create a lab (pick its node, fast/slow quota, base image, and container options). Container
  options (CPU/RAM/shared-memory/image-size quota/restart) are **set once at creation**; changing them
  needs *Recreate container* (data is preserved). All GPUs are always attached. Quotas are editable
  **live**. The lab detail page shows storage-over-time and members.
- **Students** — add a student to a lab (a password is generated and emailed; shown once in the UI) or
  bulk-import from CSV with a configurable column mapping. Removing a student optionally deletes their
  data.
- **GPU** — live GPU processes per node and recent idle-kill events.
- **Logs** — filter by level/node/search; click a task to trace its lifecycle.

### Build a lab base image

A default Ubuntu image is in [image/](image/): it runs **systemd** as PID 1 with SSH and **one shared
Docker daemon** for nested containers, whose data-root is pinned to the lab's fast tier
(`/labdata/fast/docker`) and which can re-pass the GPU into nested containers via the NVIDIA toolkit.
Under the Sysbox runtime this daemon (and per-user sudo) is host-isolated. Each user is granted `sudo`
and added to the `docker` group when the agent provisions them. Nested Docker is a last resort — the
lab container already has sudo, Python, and GPU access; see [STUDENT_GUIDE.md](STUDENT_GUIDE.md) for
when/how to use it (GPU + storage passthrough).

```bash
docker build -t custom-ssh ./image     # run on each node, or push to a registry the nodes can pull
```

Use any image name in the lab create form; it must run an SSH server and allow `useradd`.

> **Pin once, patch forever.** This image is meant to be built once and frozen for 1–2 years
> (the `FROM` digest stays put). Running containers are kept current by the agent's **weekly
> in-container `apt-get update && upgrade`** (`docker exec lab-<lab> …`, run as container-root),
> scheduled from a persistent local record (`/var/lib/lab-agent/maintenance.json`, anacron-style:
> a window missed while a node was down is caught up on the next check). Security patching is thus
> decoupled from the frozen image digest, and the cadence lives in agent code that updates
> independently of the image. Tune it in `config.toml` (`apt_update_enabled`,
> `apt_update_interval_s`); `lab-agent doctor` shows each lab's last patch time.

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
