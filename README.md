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
| `/fast/<lab>` | `/fast` | Fast lab dataset and quota |
| local ZFS or SMB `<cold-root>/<lab>` | `/cold` | Cold lab root |
| `/fast/<lab>/<user>` | `/home/<user>/scratch` | Student fast directory |
| `<cold-root>/<lab>/<user>` | `/home/<user>/cold-storage` | Student cold directory |
| agent state `labquota/<lab>` | `/run/labquota` read-only | Usage communication |

No additional shared or per-user dataset layers are created.

## 1. Prepare every host

Use a dedicated Ubuntu 22.04/24.04 node with Docker Engine, ZFS, AppArmor, NVIDIA drivers and
NVIDIA Container Toolkit where GPUs are present. Every node must reserve the same IDs:

```text
user:  labdockremap
subuid/subgid start: 231072
range: 65536
student container IDs: 10000-59999
mapped host ID: 231072 + container ID
```

Create the storage roots. The agent creates the per-lab datasets, but the pools and Docker backing
filesystem must already exist:

```bash
sudo zfs create -o mountpoint=/fast fast/labs
sudo zfs create slow/labs                    # local cold-storage nodes only
```

Choose one rootfs-quota-capable Docker backing store before `host-prepare`:

```bash
# ZFS option: put Docker's data-root on a dedicated dataset and set "storage-driver": "zfs"
sudo systemctl stop docker
sudo zfs create -o mountpoint=/var/lib/docker fast/docker

# OR overlay2 option: mount an XFS filesystem at /var/lib/docker with prjquota/pquota.
findmnt -no FSTYPE,OPTIONS /var/lib/docker
```

The doctor rejects other storage drivers and rejects `overlay2` unless its backing filesystem is
XFS with project quotas. This prevents a configured `rootfs_quota` from silently doing nothing.

If cold storage is SMB, mount it at the configured `slow_path` before starting the agent. The share
must preserve numeric POSIX ownership and permit `chown`; an absent mount is a hard failure and the
agent never creates a local fallback directory.

Install the agent, edit its config, then converge host security and Docker configuration:

```bash
cd agent
sudo python3 -m pip install .
sudo lab-agent install
sudo lab-agent edit-config
sudo lab-agent host-prepare
```

`host-prepare` is idempotent and does all of the following:

- creates `labdockremap` and exact `/etc/subuid` and `/etc/subgid` entries;
- writes Docker `userns-remap` and `data-root`, then restarts Docker;
- enforces `kernel.unprivileged_userns_clone=1`, `user.max_user_namespaces=16384`, and
  `kernel.apparmor_restrict_unprivileged_userns=1`;
- installs and loads `lab-codex-seccomp.json`, `lab-codex`, and the distribution
  `bwrap-userns-restrict` profile when available;
- regenerates NVIDIA CDI at `/etc/cdi/nvidia.yaml` when `nvidia-ctk` is installed.

Inspect the resulting Docker settings before accepting work:

```bash
docker info --format '{{json .SecurityOptions}}'
sudo cat /etc/docker/daemon.json
sudo aa-status | grep lab-codex
sysctl kernel.unprivileged_userns_clone user.max_user_namespaces \
  kernel.apparmor_restrict_unprivileged_userns
```

Nodes are dedicated to managed labs because Docker user-namespace remapping is daemon-wide.

## 2. Build the lab image

```bash
docker build -t custom-ssh image
```

The image contains systemd, SSH, sudo, Python, Node.js LTS, bubblewrap, uidmap, seccomp support,
Git, ripgrep, curl, proc tools, and a version-pinned Codex CLI. It intentionally contains no Docker
packages, daemon configuration, socket, inner NVIDIA runtime, or NVIDIA service.

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

Also verify `nvidia-smi`, Codex workspace writes under `~/scratch`, network namespace isolation, and
that container root cannot modify a host sentinel outside `/fast` and `/cold`.

## 4. Controller operations

Run the controller normally, register each node, and create lab placements. The controller assigns
every student a globally unique UID/GID from `10000-59999`; recreating a container preserves numeric
ownership.

The Nodes page exposes:

- **Check**: refresh structured Docker/userns, bubblewrap/Codex, NVIDIA, CDI, ZFS and SMB health;
- **Repair**: reload AppArmor, restore non-setuid mode on `bwrap`, regenerate CDI, and restart
  affected lab containers;
- **Patch all nodes**: queue an administrator-approved `package=version` APT manifest and retain one
  result per node;
- **Reboot**: schedule a reboot, which is the supported response to an NVML kernel/userspace mismatch.

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
