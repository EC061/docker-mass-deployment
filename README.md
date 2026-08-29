# Lab Manager: runc, CUDA development, and bubblewrap

This repository runs one standard `runc` container per lab. There is no container engine inside a
lab, no host engine socket, and no privileged mode. Students retain full password-authenticated
`sudo` inside the lab. Managed labs use Docker's per-container host user namespace because a
daemon-remapped parent namespace locks the inherited mounts that nested bubblewrap must modify.

The lab image starts from Ubuntu 24.04 and installs NVIDIA's minimal CUDA 13.3 build packages. It
includes `nvcc`, the CUDA runtime and headers needed for basic CUDA applications, standard C/C++
build tooling, Python, and distribution `/usr/bin/bwrap`; it does not install the full CUDA library
suite, Node.js, npm, or Codex. The outer container uses a dedicated seccomp profile and runs
confined by the `lab-codex` AppArmor profile, with **no added capabilities** and a plain
(non-setuid) `/usr/bin/bwrap`.

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
sudo uvx --from "$REPO" lab-agent host-prepare  # Docker, ZFS, AppArmor, mergerfs when configured
# ... create/import the independent zpools named in config, or add a disk from Node -> Storage ...
sudo uvx --from "$REPO" lab-agent host-prepare  # Docker native-ZFS data-root + lab mount service
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
`~/scratch` path exists inside the container. Backing pool/branch paths are never exposed there.

## Multi-drive storage architecture

Fast lab storage and locally-owned cold storage are generic tiers. A one-pool tier keeps the legacy
native-ZFS layout. A tier with two or more independent pools creates one quota-bearing dataset per
lab on every pool and one mergerfs mount **per lab**:

```text
fast1/labs/labA -> /mnt/lab-storage/fast1/labs/labA --\
                                                           mergerfs -> /fast/labA -> /home
fast2/labs/labA -> /mnt/lab-storage/fast2/labs/labA --/

cold1/labs/labA -> /mnt/lab-storage/cold1/labs/labA --\
                                                           mergerfs -> /cold-storage/labA
cold2/labs/labA -> /mnt/lab-storage/cold2/labs/labA --/
```

The pools are independent, not vdevs in one large zpool. Losing one disk therefore does not destroy
the other pools; the union drops the missing branch and keeps surviving files accessible. A missing
branch retains its last quota allocation in agent state and survivors never automatically inherit
it. Destructive lab removal is blocked while a branch is missing.

Docker is deliberately separate. Its data root remains a native ZFS dataset such as
`fast1/docker`, using Docker's `zfs` storage driver; it is never put on mergerfs. The Docker pool may
be the first fast pool or a dedicated pool.

Hard lab quotas remain ZFS quotas. The configured logical quota is split across the lab's branch
datasets; allocation changes shrink donors before growing receivers, never move files, never shrink
below used data, and maintain `sum(branch quotas + missing reservations) <= configured quota`.

Per-student quotas, when set, work the same way one level down: the student's directory is promoted
to a dataset on every branch and their quota is sharded across those datasets under the same
invariants. A branch with no capacity left to back a positive quota is skipped, not created
unbounded.

The Nodes page links to a per-node Storage view showing devices, pool/tier membership, capacity,
health, scrubs, mergerfs settings, Docker backing storage, and advanced branch allocations. It can
refresh inventory, reconcile mounts, rebalance quota capacity, attach an existing pool, or initialize
an unused stable `/dev/disk/by-id/...` device after an explicit destructive confirmation. Detaching a
pool is deliberately not a UI button — it is `lab-agent storage remove-pool` on the node, described
under "Degraded operation and recovery" in `HOST_PREPARATION.md`.

Because the split follows each pool's free space, a drive that also carries Docker's data-root is
handed a smaller share — but only as that data-root actually grows, since the shares are recomputed
from live free space rather than from provisioned quotas. Settings → Storage quota rebalance turns
that recomputation into a schedule (off by default) that runs on every online ZFS node. Rebalancing
only rewrites ZFS quota properties, so an hourly interval is affordable; the accompanying "ignore
changes smaller than" deadband stops constant drift in free space from rewriting and logging every
quota on every pass. The per-node button always re-slices exactly, ignoring the deadband.

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

Bubblewrap runs its **unprivileged** path: `/usr/bin/bwrap` is plain `0755`, the container adds no
capabilities, and bwrap creates a user namespace first, gaining its setup capabilities inside that
namespace where they have no authority over the host. Three container settings make that work, all
fixed at creation time:

- `--security-opt seccomp=<lab-codex-seccomp.json>` — Docker's default policy masks every
  `CLONE_NEW*` flag off `clone(2)` for containers without `CAP_SYS_ADMIN`, and that is the only
  thing that blocks unprivileged user namespaces on a current engine.
- `--security-opt apparmor=lab-codex` — labs must stay **confined**. Under Ubuntu's
  `kernel.apparmor_restrict_unprivileged_userns` an *unconfined* task cannot write its own
  `/proc/self/uid_map`, so `apparmor=unconfined` breaks bwrap outright. The profile's
  `lab-codex//lab-codex-bwrap` child grants the mount, `pivot_root`, and `userns` permissions the
  sandbox needs; the parent profile denies mounting.
- `--security-opt systempaths=unconfined` — removes runc's `/proc` overmounts, without which the
  kernel rejects the fresh procfs a nested PID namespace requires.

Doctor flags any lab that is unconfined, still carries the legacy `SYS_ADMIN`/`NET_ADMIN`/
`SYS_PTRACE` capabilities, or whose `bwrap` is setuid, and requires recreation for each.

Also verify `nvidia-smi`, CUDA compilation, network namespace isolation, and that container root
cannot modify a host sentinel outside `/home` and `/cold-storage`.

## Controller operations

Run the controller normally, register each node, and create lab placements. The controller assigns
every student a globally unique UID/GID from `10000-59999`; recreating a container preserves numeric
ownership.

The Nodes page exposes:

- **Check**: refresh structured Docker/userns, bubblewrap/Codex, NVIDIA, CDI, ZFS and SMB health;
- **Repair**: reload AppArmor, refresh security-profile permissions, regenerate CDI, and restart
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
