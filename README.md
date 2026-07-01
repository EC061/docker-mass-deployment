# Lab Manager: runc, Docker user namespaces, and Codex

This repository runs one standard `runc` container per lab. There is no container engine inside a
lab, no host engine socket, and no privileged mode. Students retain full `sudo` inside the lab;
daemon-wide `userns-remap` maps that root account to an unprivileged host ID.

Codex is a required workload. The lab image includes a pinned Codex CLI and distribution
`/usr/bin/bwrap`; the outer container uses dedicated seccomp and AppArmor profiles that allow
bubblewrap to create nested unprivileged namespaces without granting outer `CAP_SYS_ADMIN`.

## Persistent layout

| Host | Lab container | Purpose |
|---|---|---|
| `/fast/<lab>` | `/home` | Persistent fast homes and per-lab fast quota |
| `/cold-storage/<lab>` | `/cold-storage` | Per-lab cold root |
| `/fast/<lab>/<user>` | `/home/<user>` | Student persistent fast home |
| `/cold-storage/<lab>/<user>` | `/cold-storage/<user>` | Student cold directory |
| agent state `labquota/<lab>` | `/run/labquota` read-only | Usage communication |

`/home/<user>/cold-storage` is a symlink to `/cold-storage/<user>`. No `/fast`, `/cold`, or
`~/scratch` path exists inside the container, and no per-user datasets are created.

## 1. Prepare every host

Use a dedicated Ubuntu 22.04/24.04 node. `host-prepare` installs Docker Engine, ZFS tools, and
AppArmor tooling itself (see below); the only prerequisites it does NOT automate are the zpool
layout (disk topology is hardware-specific) and, on GPU nodes, the NVIDIA driver itself (needs a
reboot and a hardware-matched version — install it before running `host-prepare`, which then adds
the NVIDIA Container Toolkit once it sees GPU hardware). Every node must reserve the same IDs:

```text
user:  labdockremap
subuid/subgid start: 231072
range: 65536
student container IDs: 10000-59999
mapped host ID: 231072 + container ID
```

Create the storage roots. The agent creates the per-lab datasets, but the pools must already exist:

```bash
sudo zfs create -o mountpoint=/fast fast/labs
sudo zfs create -o mountpoint=/cold-storage slow/labs  # local cold owners only
```

`host-prepare` provisions the Docker backing store itself as a native ZFS dataset on the fast pool
(`<fast_pool>/<docker_dataset_name>`, default `fast/docker`) mounted directly at the `data-root`,
with `storage-driver: zfs` in `daemon.json`, **but only once the fast pool (and, on a local ZFS
cold tier, the slow pool too) actually exist**. If the zpool(s) aren't there yet — e.g. this is a
brand-new node and disks/zpools haven't been provisioned — `host-prepare` just installs Docker on
its plain default backing store instead of failing outright; `lab-agent doctor` accepts that as
expected until the pools show up (it already reports them missing separately). Docker's zfs driver
clones the dataset per image layer and per container, so a configured `rootfs_quota`
(`--storage-opt size=`) is enforced via ZFS's own `quota` property on each container's clone — no
XFS, no zvol, no `/etc/fstab` entry to maintain. The dataset itself is capped by `docker_quota_gb`
(default 1024 GiB; `0` = unlimited, sharing the rest of the fast pool). Unlike a zvol this is a
**live** property: change `docker_quota_gb` and re-run `host-prepare` to resize immediately, with
no unmount or reboot.

Whenever the dataset doesn't exist yet and the data-root already has content — a fresh docker-ce
install's just-created default state, or a data-root Docker has genuinely been running against
under the plain backing store because the zpool(s) only just appeared — that content is moved
aside, the dataset is created at the same mountpoint, and the content is copied back into it before
the backup is removed. Nothing is discarded and nothing is left duplicated on the old filesystem.

Once the fast (and, if applicable, slow) pool(s) exist, the doctor rejects any storage driver other
than `zfs`; before that it accepts whatever Docker's plain install picked.

If cold storage is SMB, mount the owner node's `/cold-storage` tree at `/cold-storage` on the client
(the configurable `slow_path`) before starting the agent. Thus the owner path
`/cold-storage/<lab>` and client path `/cold-storage/<lab>` are two views of the exact same backing
directory. The share must preserve numeric POSIX ownership and permit `chown`; an absent mount is a
hard failure and the agent never creates a local fallback directory. Owner and client must report
the same `userns_start` and `userns_size`, or the controller rejects the SMB placement.

Install the agent, edit its config, then converge host security and Docker configuration:

```bash
cd agent
sudo python3 -m pip install .
sudo lab-agent install
sudo lab-agent edit-config
sudo lab-agent host-prepare
```

`host-prepare` is idempotent and does all of the following:

- installs Docker Engine (from Docker's official apt repo), `zfsutils-linux`, and AppArmor tooling
  if missing — a fully unprovisioned node needs nothing pre-installed but the OS itself; on an
  already-provisioned node this step is a handful of fast `dpkg` checks and touches the network
  only when something is actually missing;
- installs `nvidia-container-toolkit` (from NVIDIA's official apt repo) when it detects NVIDIA GPU
  hardware and the package isn't already present — it never installs the NVIDIA driver itself;
- creates `labdockremap` and exact `/etc/subuid` and `/etc/subgid` entries;
- once the fast (and, if applicable, slow) zpool(s) exist, provisions the
  `<fast_pool>/<docker_dataset_name>` ZFS dataset, mounts it at the `data-root` (migrating in any
  existing content first), and applies `docker_quota_gb` as a live ZFS quota — otherwise leaves
  Docker on its plain default backing store;
- writes Docker `userns-remap` and `data-root`, adds `storage-driver=zfs` once the dataset above is
  in use, and on GPU nodes pins `exec-opts: ["native.cgroupdriver=cgroupfs"]` to work around a
  [known runc/systemd-cgroup-driver bug](https://github.com/opencontainers/runc/discussions/1133)
  that drops a container's GPU device access on `systemctl daemon-reload`, then restarts Docker;
- enforces `kernel.unprivileged_userns_clone=1`, `user.max_user_namespaces=16384`, and
  `kernel.apparmor_restrict_unprivileged_userns=1`;
- installs and loads `lab-codex-seccomp.json`, `lab-codex`, and the distribution
  `bwrap-userns-restrict` profile when available;
- regenerates NVIDIA CDI at `/etc/cdi/nvidia.yaml` when `nvidia-ctk` is installed.

Seccomp policy is fixed when Docker creates a container. If an agent upgrade changes
`lab-codex-seccomp.json`, run `host-prepare` and recreate each existing placement; restarting its
container does not apply the new policy. `lab-agent doctor` reports containers whose stamped
profile digest differs from the installed profile.

Inspect the resulting Docker settings before accepting work:

```bash
docker info --format '{{json .SecurityOptions}}'
sudo cat /etc/docker/daemon.json
sudo aa-status | grep lab-codex
sysctl kernel.unprivileged_userns_clone user.max_user_namespaces \
  kernel.apparmor_restrict_unprivileged_userns
```

Nodes are dedicated to managed labs because Docker user-namespace remapping is daemon-wide.

## 2. Get the lab image

The default image is `ghcr.io/ec061/custom-ssh:latest`, built and pushed by the `Build lab image`
GitHub Actions workflow (`image/Dockerfile`) on every merge to main. The agent pulls it before every
create or recreate, so mutable tags never deploy a stale locally cached image.

To customize the image or build offline instead, build it locally under that same tag and point
placements at it (or override the image per-placement in the controller UI):

```bash
docker build -t ghcr.io/ec061/custom-ssh:latest image
```

The image runs OpenSSH directly as PID 1 and contains sudo, Python, Node.js LTS, bubblewrap, uidmap,
seccomp support, Git, ripgrep, curl, proc tools, and a version-pinned Codex CLI. It intentionally
contains no systemd, Docker packages, daemon configuration, socket, inner NVIDIA runtime, or NVIDIA
service.

## 3. Start and validate the node

```bash
sudo lab-agent start
sudo lab-agent doctor
```

The final doctor check needs a running lab with at least one provisioned student because it executes
the real bubblewrap and Codex smoke tests as that ordinary user. A lab is not healthy until these
commands pass inside its outer container:

```bash
bwrap --ro-bind / / --proc /proc --dev /dev \
  --unshare-user --unshare-pid --unshare-net --new-session true
unshare --user --map-root-user true
codex --version
codex sandbox linux -- true
```

Also verify `nvidia-smi`, Codex workspace writes under the student's home, network namespace
isolation, and that container root cannot modify a host sentinel outside `/home` and
`/cold-storage`.

## 4. Controller operations

Run the controller normally, register each node, and create lab placements. The controller assigns
every student a globally unique UID/GID from `10000-59999`; recreating a container preserves numeric
ownership.

The Nodes page exposes:

- **Check**: refresh structured Docker/userns, bubblewrap/Codex, NVIDIA, CDI, ZFS and SMB health;
- **Repair**: reload AppArmor, restore non-setuid mode on `bwrap`, regenerate CDI, and restart
  affected lab containers;
- **Reboot**: schedule a reboot, which is the supported response to an NVML kernel/userspace mismatch.

Cold quotas, aggregate cold usage, scrubs, and quota alerts are authoritative only on the local-ZFS
owner. SMB placements scan the shared directory for their own per-student view, but the controller
never sums that duplicate view. Student deletion removes accounts and node-local fast homes from
every placement first, then queues one cold cleanup on each owning node.

Unknown DKMS, Secure Boot, Fabric Manager, and kernel failures remain critical for operator repair.
Missing storage and Docker/userns failures block lab creation. CDI/MIG changes regenerate CDI and
restart affected labs; kernel module replacement is never attempted live.

## Verification

```bash
cd agent
uv run --extra dev ruff check src tests
uv run --extra dev pytest -q

cd ../controller
npm run typecheck
npm run lint
npm test
npm run build
```

Host-only integration checks must run on a real Ubuntu node; macOS can run the static/unit suite but
cannot validate AppArmor, ZFS, Docker user namespaces, CDI, NVML, or nested Linux namespaces.
