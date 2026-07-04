# Host Preparation

Step-by-step guide for preparing an Ubuntu 22.04/24.04 agent node. Every GPU node
needs an NVIDIA driver installed and pinned before the agent touches anything.

## Overview

```
1. Install the agent          (gives you the lab-agent CLI)
2. Run host-prepare           (installs Docker, ZFS utils, AppArmor, nvidia-container-toolkit)
3. Create ZFS datasets        (zpool layout is hardware-specific)
4. Run host-prepare again     (provisions Docker data-root on ZFS, applies quotas)
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
- **AppArmor tooling** (`apparmor`, `apparmor-utils`)
- **NVIDIA Container Toolkit** (only when GPU hardware is detected —
  never the driver itself)

It also:

- reserves the `labdockremap` account and its exact subuid/subgid range
- enforces `kernel.unprivileged_userns_clone=1`,
  `user.max_user_namespaces=16384`, and
  `kernel.apparmor_restrict_unprivileged_userns=1`
- installs the seccomp profile and AppArmor profile
- writes `/etc/docker/daemon.json`

On a brand-new node the zpools don't exist yet, so Docker gets its plain
default backing store. That is expected — the next two steps fix it.

## 3. Create ZFS datasets

Disk topology is hardware-specific and not automated. Create the storage
roots the agent expects:

```bash
sudo zfs create -o mountpoint=/fast fast/labs
sudo zfs create -o mountpoint=/cold-storage slow/labs   # local cold tier only
```

Adjust pool names if you set non-default `fast_pool` / `slow_pool` values
in the agent config.

If cold storage is SMB, mount the owner node's `/cold-storage` tree at
`/cold-storage` on this client before starting the agent. The share must
preserve numeric POSIX ownership and permit `chown`.

## 4. Second host-prepare run

```bash
REPO="git+https://github.com/EC061/docker-mass-deployment.git#subdirectory=agent"
sudo uvx --from "$REPO" lab-agent host-prepare
```

Now that the fast pool exists, host-prepare provisions a ZFS dataset
(`fast/docker` by default) as Docker's `data-root` with `storage-driver:
zfs`. Any content Docker created on its plain backing store during the
first run is migrated into the dataset — nothing is discarded.

This run also applies `docker_quota_gb` (default 1024 GiB) as a live ZFS
quota on the dataset. Change the value in the config and re-run
host-prepare to resize immediately, with no unmount or reboot.

On GPU nodes, host-prepare additionally pins Docker's cgroup driver to
`cgroupfs` (workaround for a known runc/systemd-cgroup-driver bug that
drops GPU device access on `systemctl daemon-reload`) and regenerates
NVIDIA CDI at `/etc/cdi/nvidia.yaml`.

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
  kernel.apparmor_restrict_unprivileged_userns
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
