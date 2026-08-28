# Host Preparation

Step-by-step guide for preparing an Ubuntu 22.04/24.04 agent node. Every GPU node
needs an NVIDIA driver installed and pinned before the agent touches anything.

## Overview

```
1. Install the agent          (gives you the lab-agent CLI)
2. Run host-prepare           (installs Docker, ZFS utils, AppArmor, nvidia-container-toolkit)
3. Create/import ZFS pools    (or initialize a drive in Node -> Storage)
4. Run host-prepare again     (native Docker ZFS + persistent tier mount service)
5. Install + pin NVIDIA driver (manual step — reboot required)
6. Start and validate         (lab-agent start, doctor, smoke tests)
```

## 1. Install the agent

```bash
# Install uv if not present
curl -LsSf https://astral.sh/uv/install.sh | sh

REPO="git+https://github.com/EC061/docker-mass-deployment.git#subdirectory=agent"

sudo uvx --from "$REPO" lab-agent install
sudo uvx --from "$REPO" lab-agent edit-config   # set controller_url, token, node_name, pool names
```

`uvx` pulls the agent from GitHub on first run and caches it. Every
subsequent `uvx` call uses the cached copy. No local clone is needed.

`lab-agent install` registers the systemd unit and writes
`/etc/lab-agent/config.toml`. Edit the config before moving on — it
needs the controller URL, authentication token, and (if non-default) the
ZFS pool names.

## 2. First host-prepare run

```bash
REPO="git+https://github.com/EC061/docker-mass-deployment.git#subdirectory=agent"
sudo uvx --from "$REPO" lab-agent host-prepare
```

This installs everything the agent itself depends on — no pre-installed
packages beyond the OS are required:

- **Docker Engine** (from Docker's official apt repo)
- **ZFS userspace tools** (`zfsutils-linux`)
- **mergerfs, FUSE and xattr tools** when either tier uses the `mergerfs` backend
- **AppArmor tooling** (`apparmor`, `apparmor-utils`)
- **NVIDIA Container Toolkit** (only when GPU hardware is detected —
  never the driver itself)

It also:

- reserves the `labdockremap` account and its exact subuid/subgid range
- enforces `kernel.unprivileged_userns_clone=1`,
  `user.max_user_namespaces=16384`,
  `kernel.apparmor_restrict_unprivileged_userns=1`,
  `fs.inotify.max_user_watches=524288`, and
  `fs.inotify.max_user_instances=1024` (labs share the host kernel's
  per-UID inotify budget; the raised caps stop VS Code Remote-SSH
  hitting ENOSPC "unable to watch for file changes" on large workspaces)
- installs the seccomp profile and AppArmor profile
- writes `/etc/docker/daemon.json`

On a brand-new node the zpools don't exist yet, so Docker gets its plain
default backing store. That is expected — the next two steps fix it.

## 3. Configure and create the storage pools

Each drive (or deliberately redundant vdev) should normally be its own independent ZFS pool. Do
not add a second single disk as a vdev of the first pool: that makes one pool depend on both disks.
The independent-pool design preserves the files on every surviving pool.

A minimal one-drive bootstrap remains compatible with future expansion:

```toml
[storage.fast]
backend = "zfs"
pools = ["fast1"]
mount_root = "/fast"

[storage.cold]
backend = "zfs"
pools = ["cold1"]
mount_root = "/cold-storage"

[storage.docker]
pool = "fast1"
dataset = "docker"
data_root = "/var/lib/docker"
quota_gb = 1024
```

Create the named pools with hardware-appropriate commands, for example:

```bash
sudo zpool create -o ashift=12 -O compression=lz4 -O atime=off \
  -O xattr=sa -O acltype=posixacl -m none cold1 /dev/disk/by-id/REPLACE_ME
```

The agent creates and mounts `<pool>/labs` and lab datasets itself. Do not manually mount mergerfs
or expose the branch root to containers. On a two-pool bootstrap, configure `backend = "mergerfs"`,
list every pool, and keep the backing datasets under the default `/mnt/lab-storage` branch root.

The default mergerfs policy is intentionally structured rather than a free-form option string:

- `category.create=mfs` selects the eligible branch with the most ZFS-reported available space;
- `moveonenospc=mfs` can relocate an open file and retry when a write gets `ENOSPC` or `EDQUOT`;
- `minfreespace=50 GiB` keeps nearly-full branches out of create selection;
- `cache.files=partial,dropcacheonclose=true` retains `mmap` compatibility on pre-6.6 kernels while
  limiting double caching with ZFS ARC;
- `allow_other` lets the lab's non-root users traverse the FUSE mount.

A file always remains wholly on one branch. Existing files are found where they already live; quota
rebalancing does not relocate them. `use_ino` is omitted because mergerfs removed that option in
2.35 and always manages inode values now. See the upstream mergerfs documentation for
[policies](https://trapexit.github.io/mergerfs/latest/config/functions_categories_policies/),
[move-on-ENOSPC](https://trapexit.github.io/mergerfs/latest/config/moveonenospc/),
[caching](https://trapexit.github.io/mergerfs/latest/config/cache/), and the
[runtime branch interface](https://trapexit.github.io/mergerfs/latest/runtime_interface/).

If cold storage is SMB, mount the owner node's `/cold-storage` tree at
`/cold-storage` on this client before starting the agent. The share must
preserve numeric POSIX ownership and permit `chown`.

## 4. Second host-prepare run

```bash
REPO="git+https://github.com/EC061/docker-mass-deployment.git#subdirectory=agent"
sudo uvx --from "$REPO" lab-agent host-prepare
```

Now that the Docker pool exists, host-prepare provisions a ZFS dataset
(`fast1/docker` in the example) as Docker's `data-root` with `storage-driver:
zfs`. Any content Docker created on its plain backing store during the
first run is migrated into the dataset — nothing is discarded.

This run also applies `docker_quota_gb` (default 1024 GiB) as a live ZFS
quota on the dataset. Change the value in the config and re-run
host-prepare to resize immediately, with no unmount or reboot.

On GPU nodes, host-prepare additionally pins Docker's cgroup driver to
`cgroupfs` (workaround for a known runc/systemd-cgroup-driver bug that
drops GPU device access on `systemctl daemon-reload`) and regenerates
NVIDIA CDI at `/etc/cdi/nvidia.yaml`.

It also installs and enables `lab-storage-mounts.service`. The oneshot service runs after ZFS
import/mount and before Docker, computes the safe live branch set, and creates one mergerfs mount per
lab. It never accepts an unmounted leftover directory as a branch. The operation is idempotent and
is also available as `sudo lab-agent storage mount`.

## Add a drive later

Preferred controller workflow:

1. Open **Nodes -> node -> Manage storage** and refresh inventory.
2. Under Fast or Cold, choose an unused stable `/dev/disk/by-id/...` disk.
3. Enter a new pool name (`fast2`, `cold2`, and so on).
4. Read and accept the destructive warning.
5. The agent creates an independent zpool, attaches it to the tier, installs mergerfs if this is the
   second pool, creates a branch for every existing lab, transfers part of each existing hard quota,
   and updates each per-lab union.

The logical quota and application paths do not change. Existing files are not moved. A one-pool
native-ZFS tier is promoted by briefly stopping only its running lab containers while dataset
mountpoints move under `/mnt/lab-storage`; they are started again against the new union. Third and
later pools normally attach live without a container restart.

An already-created pool can be attached locally while the controller is unavailable:

```bash
sudo lab-agent storage add-pool --tier cold --pool cold2
sudo lab-agent storage rebalance --tier cold
sudo lab-agent storage status --json
```

The topology change is written to `/etc/lab-agent/config.toml`, because local bootstrap storage is
authoritative at boot. Per-lab quotas remain controller-authoritative; device/pool health is always
reported live hardware state.

## Degraded operation and recovery

If a configured pool disappears, the tier reports `degraded`; mergerfs removes the dead path and
keeps surviving branches accessible. The agent does not recreate the missing dataset elsewhere,
does not expand survivor quotas into the missing allocation, and blocks lab destruction. If all
branches are gone, the logical mount is deliberately left down so writes cannot fall through to the
root filesystem.

Restore/import the same pool and run `lab-agent storage mount`; its branches are attached live. An
administrator may explicitly detach a lost pool only after accepting that its files will no longer
be part of the logical tier. Automated drain/data rebalance and failed-disk replacement copying are
not implemented yet; recover data at the branch dataset level or restore from an external copy.

Cold-storage SMB clients do none of this management. The owner exports its unchanged logical
`/cold-storage` tree, while clients keep mounting that share and never scrub or quota the owner's
pools.

## 5. Install and pin the NVIDIA driver

host-prepare explicitly **never installs the NVIDIA kernel driver** — it
needs a reboot and a hardware-matched version choice. Install it manually
before starting the agent.

### 5a. Add the NVIDIA driver apt repo

```bash
# Import the signing key
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --yes --dearmor -o /usr/share/keyrings/nvidia-driver-keyring.gpg

# Detect your Ubuntu codename
. /etc/os-release

# Add the repo (replace jammy/noble as needed)
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/nvidia-driver-keyring.gpg] \
  https://us.download.nvidia.com/tesla ${VERSION_CODENAME}/" \
  | sudo tee /etc/apt/sources.list.d/nvidia-driver.list

sudo apt-get update
```

> For Tesla/Data Center GPUs use the `us.download.nvidia.com/tesla` repo.
> For GeForce/RTX workstation GPUs use `https://ppa.launchpadcontent.net/ubuntu-nvidia-drivers/ppa/ubuntu`
> or the graphics-drivers PPA instead.

### 5b. Install the driver

```bash
# List available driver packages
apt-cache search nvidia-driver | grep '^nvidia-driver-[0-9]'

# Install (example: 550)
sudo apt-get install -y nvidia-driver-550
```

Reboot after installation:

```bash
sudo reboot
```

Verify after reboot:

```bash
nvidia-smi
```

### 5c. Pin the driver against updates

Three layers prevent `apt-get upgrade` or `unattended-upgrades` from
touching the driver packages:

**Hold every installed NVIDIA driver package:**

```bash
sudo apt-mark hold \
  nvidia-driver-550 \
  libnvidia-compute-550 \
  libnvidia-decode-550 \
  libnvidia-encode-550 \
  libnvidia-fbc1-550 \
  libnvidia-gl-550 \
  nvidia-compute-utils-550 \
  nvidia-dkms-550 \
  nvidia-utils-550
```

Adjust the list to match what `dpkg -l | grep nvidia` shows on your
node. The pattern is `nvidia-driver-NNN` plus all `libnvidia-*` and
`nvidia-*-NNN` packages at the same version.

**Create an apt priority pin so apt never considers upgrading them:**

```bash
sudo tee /etc/apt/preferences.d/nvidia-driver-pin <<'EOF'
Package: nvidia-driver-* libnvidia-* nvidia-compute-utils-* nvidia-dkms-* nvidia-utils-*
Pin: version *
Pin-Priority: 1001
EOF
```

Priority 1001 forces apt to keep the installed version even when a
newer version is available in the repo.

**Blacklist the packages in unattended-upgrades:**

```bash
sudo tee /etc/apt/apt.conf.d/50unattended-upgrades-nvidia <<'EOF'
Unattended-Upgrade::Package-Blacklist {
    "nvidia-driver-.*";
    "libnvidia-.*";
    "nvidia-compute-utils-.*";
    "nvidia-dkms-.*";
    "nvidia-utils-.*";
};
EOF
```

### 5d. Updating the driver (when intended)

When you intentionally want to upgrade the NVIDIA driver:

```bash
sudo apt-mark unhold nvidia-driver-550 libnvidia-compute-550 ...
sudo apt-get install -y nvidia-driver-560   # new version
sudo reboot

# After verifying nvidia-smi on the new version, re-pin:
sudo apt-mark hold nvidia-driver-560 libnvidia-compute-560 ...
sudo tee /etc/apt/preferences.d/nvidia-driver-pin <<'EOF'
Package: nvidia-driver-* libnvidia-* nvidia-compute-utils-* nvidia-dkms-* nvidia-utils-*
Pin: version *
Pin-Priority: 1001
EOF
```

Update the unattended-upgrades blacklist if the package set changed.

## 6. Start and validate

```bash
REPO="git+https://github.com/EC061/docker-mass-deployment.git#subdirectory=agent"
sudo uvx --from "$REPO" lab-agent start
sudo uvx --from "$REPO" lab-agent doctor
```

Doctor needs a running lab with at least one provisioned student because
it executes real namespace and Codex smoke tests as that ordinary user.

Verify inside a running lab:

```bash
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid -- echo "bwrap works"
nvcc --version
nvidia-smi
```

Inspect the resulting Docker and system settings:

```bash
docker info --format '{{json .SecurityOptions}}'
sudo cat /etc/docker/daemon.json
sudo aa-status | grep lab-codex
sysctl kernel.unprivileged_userns_clone user.max_user_namespaces \
  kernel.apparmor_restrict_unprivileged_userns \
  fs.inotify.max_user_watches fs.inotify.max_user_instances
```

## Persistent layout reference

| Host | Lab container | Purpose |
|---|---|---|
| `/fast/<lab>` | `/home` | Persistent fast homes and per-lab fast quota |
| `/cold-storage/<lab>` | `/cold-storage` | Per-lab cold root |
| `/fast/<lab>/<user>` | `/home/<user>` | Student persistent fast home |
| `/cold-storage/<lab>/<user>` | `/cold-storage/<user>` | Student cold directory |
| agent state `labquota/<lab>` | `/run/labquota` read-only | Usage communication |

`/home/<user>/cold-storage` is a symlink to `/cold-storage/<user>`. No
`/fast`, `/cold`, or `~/scratch` path exists inside the container, and no
per-user datasets are created.

## Subordinate ID mapping

Every node must reserve the same IDs for cross-node cold-storage numeric
consistency:

```text
user:  labdockremap
subuid/subgid start: 231072
range: 65536
student container and host IDs: 10000-59999
```

This is created automatically by `host-prepare`.

## Real-host storage integration checklist

Unit tests mock ZFS/mergerfs. Before production rollout, use a disposable Ubuntu ZFS host and verify:

```bash
sudo lab-agent host-prepare
sudo systemctl restart lab-storage-mounts.service
sudo lab-agent storage status --json
findmnt -t zfs,fuse.mergerfs
sudo getfattr -n user.mergerfs.branches /cold-storage/LAB/.mergerfs
sudo zfs get -r used,quota,available cold1/labs cold2/labs
sudo lab-agent doctor
```

Then export one test pool, run `storage mount` and confirm the missing branch is absent from the
xattr while surviving files remain readable. Re-import it and confirm the branch returns. Always use
disposable data for destructive pool-creation testing.
