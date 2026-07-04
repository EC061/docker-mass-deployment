# Lab Manager: runc, CUDA development, and bubblewrap

This repository runs one standard `runc` container per lab. There is no container engine inside a
lab, no host engine socket, and no privileged mode. Students retain full password-authenticated
`sudo` inside the lab. Managed labs use Docker's per-container host user namespace because a
daemon-remapped parent namespace locks the inherited mounts that nested bubblewrap must modify.

The lab image starts from Ubuntu 24.04 and installs NVIDIA's minimal CUDA 13.3 build packages. It
includes `nvcc`, the CUDA runtime and headers needed for basic CUDA applications, standard C/C++
build tooling, Python, and distribution `/usr/bin/bwrap`; it does not install the full CUDA library
suite, Node.js, npm, or Codex. The outer container uses a dedicated seccomp profile,
`apparmor=unconfined`, and the three capabilities required by bubblewrap's setuid setup path:
`SYS_ADMIN`, `NET_ADMIN`, and `SYS_PTRACE`.

## Host preparation

Every agent node needs Docker, ZFS, AppArmor, and — on GPU nodes — the NVIDIA driver and
container toolkit. The full step-by-step is in **[HOST_PREPARATION.md](HOST_PREPARATION.md)**.

In short:

```bash
# Install uv if not present
curl -LsSf https://astral.sh/uv/install.sh | sh

REPO="git+https://github.com/EC061/docker-mass-deployment.git#subdirectory=agent"

sudo uvx --from "$REPO" lab-agent install
sudo uvx --from "$REPO" lab-agent edit-config
sudo uvx --from "$REPO" lab-agent host-prepare  # installs Docker, ZFS utils, AppArmor, nvidia-container-toolkit
# ... create zpools (hardware-specific) ...
sudo zfs create -o mountpoint=/fast fast/labs
sudo zfs create -o mountpoint=/cold-storage slow/labs
sudo uvx --from "$REPO" lab-agent host-prepare  # provisions Docker data-root on ZFS
# ... install + pin NVIDIA driver (GPU nodes only, see HOST_PREPARATION.md) ...
sudo uvx --from "$REPO" lab-agent start
sudo uvx --from "$REPO" lab-agent doctor
```

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

## Get the lab image

The default image is `ghcr.io/ec061/custom-ssh:latest`, built and pushed by the `Build lab image`
GitHub Actions workflow (`image/Dockerfile`) on every merge to main. The agent pulls it before every
create or recreate, so mutable tags never deploy a stale locally cached image.

To customize the image or build offline instead, build it locally under that same tag and point
placements at it (or override the image per-placement in the controller UI):

```bash
docker build -t ghcr.io/ec061/custom-ssh:latest image
```

The image runs OpenSSH directly as PID 1 and uses a pinned Ubuntu 24.04 base plus NVIDIA's
`cuda-minimal-build-13-3` package. It contains `nvcc`, the basic CUDA headers/runtime, GCC/G++,
CMake, Ninja, pkg-config, Python (as both `python` and `python3`), sudo, bubblewrap, Git, ripgrep,
curl, and proc tools. Large optional CUDA math libraries, profilers, documentation, and samples are
excluded. It intentionally contains no Node.js, npm, Codex, systemd, Docker packages, daemon
configuration, socket, or inner NVIDIA container runtime.

## Start and validate the node

```bash
sudo lab-agent start
sudo lab-agent doctor
```

The final doctor check needs a running lab with at least one provisioned student because it executes
the real namespace and Codex smoke tests as that ordinary user. A lab is not healthy until these
commands pass inside its outer container:

```bash
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid -- echo "bwrap works"
nvcc --version
```

Doctor executes that exact bwrap smoke test and `nvcc --version` as a provisioned ordinary student.
Managed labs enforce root ownership and setuid mode (`4755`) on `/usr/bin/bwrap`, and run with
`--security-opt apparmor=unconfined` plus `SYS_ADMIN`, `NET_ADMIN`, and `SYS_PTRACE`, which the
setuid bubblewrap code requires while constructing the nested sandbox. Labs must stay
`apparmor=unconfined`: setuid bwrap cannot build its sandbox under the `lab-codex` profile on
production kernels, and doctor flags any confined lab for recreation. The dedicated seccomp profile
remains enabled. `host-prepare` and `Repair` re-assert this bwrap mode; capability changes
require container recreation.

Also verify `nvidia-smi`, CUDA compilation, network namespace isolation, and that container root
cannot modify a host sentinel outside `/home` and `/cold-storage`.

## Controller operations

Run the controller normally, register each node, and create lab placements. The controller assigns
every student a globally unique UID/GID from `10000-59999`; recreating a container preserves numeric
ownership.

The Nodes page exposes:

- **Check**: refresh structured Docker/userns, bubblewrap/Codex, NVIDIA, CDI, ZFS and SMB health;
- **Repair**: reload AppArmor, restore setuid-root mode on `bwrap`, regenerate CDI, and restart
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
