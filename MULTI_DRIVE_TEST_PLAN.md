# Multi-Drive Storage Test Plan — 2 × 4 TB SSD + 1 × 8 TB HDD (+ optional 2nd 8 TB HDD)

Execution document for a **future AI agent working with a human operator**. Every step is
labelled:

| Marker | Meaning |
|---|---|
| 👤 **HUMAN** | Requires physical access, a credential, a browser session, or an irreversible decision. The agent must stop and ask. |
| 🤖 **AGENT** | The agent can run it unattended (shell on the node, or repo tooling), then report the captured output. |
| 👤🤖 **PAIR** | Agent prepares/asserts, human clicks the destructive button or confirms. |

**Controller under test:** `https://lab.edwardcheng.net` (agent WebSocket endpoint `wss://lab.edwardcheng.net/agent` — see `controller/server.ts:30`).

**Golden rule for this plan:** every byte written in Phases 0–9 is disposable. Do not run any
phase against real student data. Phase 10 is the reset that produces the production baseline.

---

## 0. Hardware, topology, and the decisions the human must make first

### 0.1 Inventory

| Slot | Device | Raw | zpool `size` (expect) | Role |
|---|---|---|---|---|
| **BOOT** | **not yet specified — see §0.1.1** | — | — | Ubuntu root filesystem, `/var/lib/lab-agent`, `/var/tmp` |
| SSD-1 | 4 TB SSD | 4.00 TB | ≈ 3.62 TiB | zpool `fast1` — fast tier branch **+ Docker data-root** |
| SSD-2 | 4 TB SSD | 4.00 TB | ≈ 3.62 TiB | zpool `fast2` — fast tier branch |
| HDD-1 | 8 TB HDD | 8.00 TB | ≈ 7.27 TiB | zpool `cold1` — cold tier |
| HDD-2 | 8 TB HDD (optional, later) | 8.00 TB | ≈ 7.27 TiB | zpool `cold2` — cold tier branch 2 |

Usable is ~3 % below `size` (ZFS slop space). Record the real numbers in the evidence log (§13).

### 0.1.1 🔴 BLOCKING QUESTION — where does the OS live? 👤 **HUMAN, answer before Phase 1**

Every pool in this design is a **whole disk**. `zpool create fast1 /dev/disk/by-id/<SSD-1>` erases
the entire device, and the controller's disk picker hides any disk carrying a partition table
(B1). So **none of the three listed drives can also hold the Ubuntu root filesystem.**

Three ways out; the human must pick one before anything is created:

* **(a) A separate boot device exists** (a 4th SATA/NVMe/USB-attached SSD, or an M.2 the inventory
  did not mention). This is the assumption the rest of the plan makes. Confirm it with
  `lsblk -o NAME,SIZE,MODEL,MOUNTPOINT` and record it.
* **(b) The OS is on one of the 4 TB SSDs.** Then that SSD cannot be a whole-disk pool. Either
  re-image the node onto a separate boot device, or accept a **partition-backed** pool
  (`zpool create fast1 /dev/disk/by-id/<SSD1>-part3`) — which `validate_device` accepts as a by-id
  path but which the UI's *Initialize disk* picker will never offer, and which makes SSD-1
  permanently unmanageable from the controller. Not recommended.
* **(c) The OS is on the 8 TB HDD.** Same problem for `cold1`, plus every lab's cold I/O competes
  with the root filesystem. Not recommended.

The boot device also needs ~20 GiB free for `/var/lib/lab-agent`, the journal, and the Phase 6
rehearsal image.

### 0.2 DECISION 1 — independent pools vs. a mirror 👤 **HUMAN**

This design deliberately uses **one independent zpool per disk** (`HOST_PREPARATION.md` §3). That
is what makes the multi-drive feature under test meaningful, and it is what this plan assumes.

**Consequence the human must accept in writing before Phase 2:** there is **no redundancy
anywhere** in this layout. A single SSD failure permanently loses every file that lives on that
branch. mergerfs keeps the *other* branch's files reachable and keeps the lab running — it does not
protect data. `zpool scrub` detects corruption but cannot repair it on a single-disk pool.

The alternative (2 × 4 TB SSD as one `mirror` vdev) gives redundancy but collapses fast to **one**
pool ≈ 3.62 TiB, of which ~1 TiB goes to Docker — and it removes the multi-pool fast tier from the
test entirely. Recommendation: **independent pools**, plus an off-node backup policy for cold.

### 0.3 DECISION 2 — cold tier backend on day one 👤 **HUMAN**

| | Option A — `backend = "mergerfs"`, `pools = ["cold1"]` | Option B — `backend = "zfs"`, `pools = ["cold1"]` |
|---|---|---|
| Day-1 layout | dataset at `/mnt/lab-storage/cold1/labs/<lab>`, 1-branch FUSE union at `/cold-storage/<lab>` | dataset mounted directly at `/cold-storage/<lab>`, no FUSE |
| Adding HDD-2 later | `attach_pool` sees `backend == "mergerfs"` already → **live xattr branch add, no container restart** | triggers `_promote_to_mergerfs` → **every lab container on the node is stopped and restarted**, ZFS mountpoints move |
| Cost | FUSE in the cold path from day one | none until the upgrade |
| Validated by | `storage/model.py:278` only rejects `zfs` with >1 pool; 1-pool mergerfs is legal | the documented default |

**Recommendation for this exercise: start with Option B.** The one-pool→mergerfs promotion is the
riskiest code path in the feature (it moves live ZFS mountpoints and restarts containers), and this
is the only safe opportunity to exercise it on disposable data. Phase 7 tests it. Then, at Phase 10,
decide whether production keeps the (now already promoted) mergerfs cold tier — after a successful
Phase 7 it will already be `mergerfs`, which is the desired end state either way.

If the human declines to ever restart containers for a storage change, choose Option A now and skip
Phase 7's promotion assertions (Phase 6's rehearsal still covers attach/rebalance/detach).

### 0.4 DECISION 3 — Docker's data-root 👤 **HUMAN**

Docker's data-root stays on **native ZFS** (`fast1/docker`, storage-driver `zfs`) and is never on
mergerfs. Default `quota_gb = 1024` (1 TiB).

Implications, all verified in code:

* The 1 TiB is a ZFS **quota**, not a reservation. `fast1`'s free space (`zpool list FREE`, which is
  what the quota allocator reads — `storage/service.py:observe_branches` → `zfs.pool_capacity`)
  only shrinks as Docker actually writes. So the fast-tier split starts near 50/50 and drifts toward
  `fast2` as images and container layers accumulate. **Phase 8 tests exactly this.**
* Per-placement `rootfsQuota` defaults to `300g` (`labs/_components/PlacementForm.tsx`). Those are
  thin ZFS clones, so four placements do not consume 1.2 TiB — but if the *sum actually written*
  reaches 1024 GiB, container creation on this node starts failing. Raise `quota_gb` or move Docker
  to `fast2` if the node will host many placements.
* The Storage page's per-tier "capacity" is `sum(pool size)` for usable pools
  (`storage/service.py:inventory` → `logical_capacity_bytes`). It therefore shows the fast tier as
  ≈ 7.2 TiB even though ~1 TiB is earmarked for Docker. **Do not size lab quotas off that number.**

Budget the human should sign off on:

```
fast tier physical      ≈ 7.24 TiB   (2 × 3.62)
  minus Docker quota    - 1.00 TiB
  minus mergerfs minfreespace (50 GiB × 2 branches, kept out of create selection)
                        - 0.10 TiB
  = allocatable to labs ≈ 6.1 TiB    (keep sum of lab fast quotas at or below this)

cold tier physical      ≈ 7.27 TiB   (1 × 8 TB), later ≈ 14.5 TiB with HDD-2
  = allocatable to labs ≈ 7.0 TiB    (ZFS slop), later ≈ 14.0 TiB
```

### 0.5 Target configuration (`/etc/lab-agent/config.toml`)

```toml
[agent]
controller_url = "wss://lab.edwardcheng.net/agent"
token = "PASTE-FROM-CONTROLLER-NODES-PAGE"
node_name = "lab-01"          # lowercase, a-z 0-9 hyphen (controller enforces this)
tls_verify = true

[storage.fast]
backend = "mergerfs"          # 2 SSDs from day one
pools = ["fast1", "fast2"]
mount_root = "/fast"
branch_root = "/mnt/lab-storage"

[storage.cold]
backend = "zfs"               # DECISION 2, Option B. Option A: "mergerfs" (same pools list)
pools = ["cold1"]
mount_root = "/cold-storage"

[storage.docker]
# NEVER mergerfs. Native ZFS dataset, storage-driver=zfs.
pool = "fast1"
dataset = "docker"
data_root = "/var/lib/docker"
quota_gb = 1024
```

Defaults the agent applies unless overridden (`storage/model.py`), which this plan asserts against:

| Setting | Default | Where |
|---|---|---|
| mergerfs `category.create` | `mfs` (most free space) | `MergerfsOptions` |
| mergerfs `moveonenospc` | `mfs` | `MergerfsOptions` |
| mergerfs `minfreespace` | **50 GiB** | `DEFAULT_MINFREESPACE` |
| mergerfs `cache.files` | `partial` + `dropcacheonclose=true` | `MergerfsOptions` |
| per-branch minimum quota headroom | **16 GiB** | `TierConfig.min_branch_headroom_bytes` |
| quota rounding granularity | 1 MiB | `storage/quota.py:QUOTA_GRANULARITY` |
| scheduled rebalance | **off**, 24 h interval, 1 GB deadband | `controller/src/lib/settings.ts:430` |

---

## 1. Blockers and risks — check these BEFORE touching hardware

Each item is a real property of the current code, with where to verify it. 🤖 The agent should
re-verify each against the checked-out tree before execution and report any that have changed.

### B1 — 🔴 The UI cannot initialize a disk that has *any* existing partition or filesystem
`createStoragePoolAction` (`controller/src/app/(app)/nodes/actions.ts`) hardcodes `force: false`,
and the disk picker filters to `!d.in_use && !d.mounted && !d.zfs_pool`
(`nodes/[name]/storage/page.tsx`). `BlockDevice.in_use` is true if the disk has *any* partition,
filesystem, mount, or ZFS label (`storage/pools.py:list_block_devices`). A previously used 8 TB HDD
will simply **not appear in the dropdown**.
**Mitigation (Phase 2):** wipe from the shell first, or create the pool by hand and use
*Attach existing pool* instead of *Initialize disk*.

### B2 — 🔴 The cold-tier promotion stops every lab container on the node
With Option B, `storageops.attach_pool` stops all running managed containers before
`service.attach_pool` moves `cold1/labs` and `cold1/labs/<lab>` mountpoints under
`/mnt/lab-storage`, then starts them again. If **any** process holds an open fd or cwd under
`/cold-storage`, `zfs set mountpoint` fails, the rollback (`_demote_from_mergerfs`) runs, and if
*that* also fails the operation reports `MANUAL RECOVERY NEEDED` naming datasets to move back by
hand.
**Mitigation (Phase 7):** maintenance window; `fuser -vm /cold-storage` must be empty; no admin
shell parked in a cold directory; capture `zfs get -r mountpoint cold1` before and after.

### B3 — 🟠 A lab with no finite recorded quota cannot be extended onto a new pool
`service._extend_lab_onto` raises *"no finite existing cold quota could be inferred"* when the
storage state has no `configured_quota_bytes` and the existing branches have no ZFS quota. That lab
is reported as **PARTIAL — branches were not added**, while other labs succeed.
**Mitigation:** before Phase 7, assert every placement on the node has a non-null
`cold_quota_bytes` and that `lab-agent storage status --json` shows a finite
`state.labs.cold.<lab>.configured_quota_bytes`.

### B4 — 🟠 Agent connects only over `wss://`, and the reverse proxy must forward the right host
`client.py:53` builds a TLS context only for `wss://`. The hub rejects the upgrade unless the
request path is `/agent` **and** the (X-Forwarded-)Host equals `CONTROLLER_DOMAIN`
(`controller/src/lib/hub.ts:~557-565`).
**Mitigation (Phase 3):** the container must run with `CONTROLLER_DOMAIN=lab.edwardcheng.net`, and
the proxy must set `X-Forwarded-Host: lab.edwardcheng.net`, pass `Upgrade`/`Connection` headers, and
not time out idle WebSockets below ~20 s (the agent pings at 20 s).

### B5 — 🟠 Small lab quotas collapse onto one branch
`quota.allocate` gives each present branch up to `min_headroom` (16 GiB) **before** the proportional
water-fill, smallest-room-first. Therefore on a 2-branch tier:
a 64 GiB lab quota → ≈ 32/32; a 20 GiB lab quota → 16/4; a **10 GiB lab quota → 10/0**, and the
second branch is not created at all (`provision_lab` logs *"pool … has no free capacity to
allocate"*).
Per-**student** quotas do not have this behaviour — `studentops` calls `allocate(..., min_headroom=0)`,
so they split purely proportionally.
**Mitigation:** keep test lab quotas ≥ 64 GiB; make this an explicit Phase 5 assertion rather than a
surprise.

### B6 — 🟠 One file can never exceed one branch's remaining quota
mergerfs never splits a file. With a 1 TiB lab quota split ≈ 512/512 GiB, a single 600 GiB file
fails with ENOSPC/EDQUOT even though the lab is 40 % empty. `moveonenospc=mfs` relocates the open
file to the branch with the most free space and retries once — which also fails if that branch is
too small.
**Mitigation:** document this for PIs; Phase 5.6 tests it deliberately.

### B7 — 🟡 mergerfs version from apt
`host-prepare` installs `mergerfs`, `attr`, `fuse3` from the distro repo. The code targets a modern
mergerfs: it relies on the `user.mergerfs.branches` runtime xattr for live branch add/remove and
deliberately omits `use_ino` (removed in 2.35, `storage/model.py` `MergerfsOptions` docstring).
**Action (Phase 1):** record `mergerfs -V`. If it is older than 2.35, install the upstream `.deb`
from the mergerfs releases before Phase 4 and record the version actually used.

### B8 — 🟡 `remove-pool` never demotes a tier back to the `zfs` backend
`TierConfig.with_pools` promotes `zfs → mergerfs` past one pool but never the reverse, and
`storageops.remove_pool` refuses to remove the last pool of a tier
(`storageops.py:266`). After detaching `cold2`, the cold tier stays `backend = "mergerfs"` with one
pool and its datasets stay under `/mnt/lab-storage`. That is a supported steady state — just not a
rollback to the original layout.
**Mitigation:** Phase 10 states the intended end state explicitly; do not expect the config to
revert.

### B9 — 🟡 Nothing enforces `sum(lab quotas) ≤ tier capacity`
The controller shows a capacity hint next to a placement's quota but does not block over-commitment;
the agent's allocator caps each branch at its physical ceiling and reports the remainder as
`unallocated` with a warning. Over-committing is silently tolerated until a disk is actually full.
**Mitigation:** Phase 5.7 deliberately over-commits and asserts the warning surfaces; keep the
production sum inside the §0.4 budget.

### B10 — 🟡 Live-branch-add fallback restarts containers
`mfs.attach_branch` prefers the live xattr path; if it fails it remounts the union and the affected
lab's container is restarted (`storageops.attach_pool` → `containers_restarted`). Third-and-later
pools *normally* attach live, but "normally" is not "always".
**Mitigation:** Phases 6/7 assert `attached_live: true` / `restart_required: false` per lab, and
treat a fallback as a finding, not a failure.

### B11 — 🟡 Degraded operation blocks lab destruction and never reallocates the missing quota
By design (`quota.reserved_for_missing`). A missing branch keeps its allocation; survivors do not
grow into it; `destroy_lab` is refused. Releasing it is an explicit `remove-pool`.
**Mitigation:** Phase 9 asserts all three behaviours so the human is not surprised mid-incident.

### B0 — 🔴 No spare device for the OS
See §0.1.1. If Ubuntu shares a disk with a planned pool, Phase 2 cannot run as written. **Resolve
before anything else.**

### B12 — 🟢 Prerequisites that will stop Phase 1 dead
Outbound network from the node to `github.com` (uvx install), `download.docker.com`,
`archive.ubuntu.com`, `ghcr.io` (lab image), and `lab.edwardcheng.net:443`. Ubuntu 22.04/24.04.
NVIDIA driver is a **manual, reboot-requiring** step and is never installed by `host-prepare`.

---

## 2. Phase 0 — Pre-flight (no hardware touched)

### 0.1 🤖 AGENT — repo test suite (run from a clone/worktree, not the node)

```bash
cd agent
uv run --extra dev ruff check src tests
uv run --extra dev pytest -q

export PATH=/opt/homebrew/opt/node@24/bin:$PATH   # node is keg-only on this Mac
cd ../controller
npm ci
npm approve-scripts better-sqlite3 esbuild fsevents unrs-resolver   # npm 11 native-script gate
git checkout -- package.json                                        # revert the allowScripts block
npm run typecheck && npm run lint && npm test && npm run build
```

**Pass:** all green. Record the commit SHA under test.
**Note:** the agent unit tests mock ZFS and mergerfs entirely (`agent/tests/fakezfs.py`,
`storagehelp.py`). Green here proves nothing about a real host — that is what Phases 4–9 are for.

### 0.2 🤖 AGENT — re-verify blockers B1–B11 against the checked-out tree
Report any that no longer hold, with file:line. Do not proceed on stale assumptions.

### 0.3 👤 HUMAN — controller readiness
On the machine serving `lab.edwardcheng.net`:

```bash
docker compose ps                       # controller running
docker compose exec controller env | grep -E 'CONTROLLER_DOMAIN|PORT|NODE_ENV'
```

**Pass:** `CONTROLLER_DOMAIN=lab.edwardcheng.net`, controller healthy, and an admin login works in a
browser. Confirm the reverse proxy sets `X-Forwarded-Host` and allows WebSocket upgrades (B4).

### 0.4 👤 HUMAN — record disk serials
Physically label SSD-1, SSD-2, HDD-1 (and HDD-2 if present) with their serial numbers. Every later
step operates on `/dev/disk/by-id/...`; the label is how you know which drive to pull if you need to.

---

## 3. Phase 1 — Node bootstrap

### 1.1 🤖 AGENT — install the agent and take a baseline

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
REPO="git+https://github.com/EC061/docker-mass-deployment.git#subdirectory=agent"
sudo uvx --from "$REPO" lab-agent install
```

Baseline capture (save all of it to the evidence log):

```bash
lsblk -o NAME,SIZE,ROTA,MODEL,SERIAL,TRAN,TYPE,MOUNTPOINT,FSTYPE
ls -l /dev/disk/by-id/ | grep -v part
cat /etc/os-release
uname -r
```

### 1.2 👤🤖 PAIR — write the config
🤖 renders §0.5 into `/etc/lab-agent/config.toml` (leave `token = ""` for now).
👤 reviews and confirms `node_name`, the pool names, and DECISION 2.

```bash
sudo uvx --from "$REPO" lab-agent edit-config     # or write the file directly
```

### 1.3 🤖 AGENT — first `host-prepare`

```bash
sudo uvx --from "$REPO" lab-agent host-prepare
```

**Expect:** Docker CE, `zfsutils-linux`, AppArmor, **and** `mergerfs`/`attr`/`fuse3`
(because `[storage.fast]` declares the mergerfs backend). Docker keeps its default backing store —
the pools do not exist yet. That is correct.

**Assertions:**

```bash
mergerfs -V                     # record it — see B7
zfs version
docker info --format '{{.Driver}} {{.DockerRootDir}}'
sysctl fs.inotify.max_user_watches fs.inotify.max_user_instances
sudo cat /etc/docker/daemon.json
```

**Pass:** inotify watches 524288, instances 1024; Docker advertises its default seccomp/AppArmor
integrations; daemon.json is present.

---

## 4. Phase 2 — Create the pools (DESTRUCTIVE)

### 2.1 👤 HUMAN — final confirmation
Read back the three by-id paths out loud against the physical labels from §0.4. This step erases
them. Confirm explicitly before the agent proceeds.

### 2.2 🤖 AGENT — resolve stable identities

```bash
sudo uvx --from "$REPO" lab-agent storage devices
```

Record the exact `/dev/disk/by-id/...` for SSD-1, SSD-2, HDD-1. Kernel names (`/dev/sdb`) are
rejected by `validate_device` — always use by-id.

### 2.3 👤🤖 PAIR — wipe any pre-existing partitioning (B1)

Only for disks that show `in_use`:

```bash
sudo wipefs -a /dev/disk/by-id/<DISK>
sudo sgdisk --zap-all /dev/disk/by-id/<DISK>
sudo partprobe; sleep 2
sudo uvx --from "$REPO" lab-agent storage devices     # must now show [free]
```

### 2.4 🤖 AGENT — create the three pools

Exactly the property set `zfs.create_pool` uses, so the hand-created pools are indistinguishable
from UI-created ones:

```bash
for spec in "fast1 <SSD1-BYID>" "fast2 <SSD2-BYID>" "cold1 <HDD1-BYID>"; do
  set -- $spec
  sudo zpool create -o ashift=12 -O compression=lz4 -O atime=off \
       -O xattr=sa -O acltype=posixacl -m none "$1" "$2"
done
zpool list -o name,size,alloc,free,health,ashift
zpool status
```

**Pass:** three pools, all `ONLINE`, `ashift=12`, sizes ≈ 3.62T / 3.62T / 7.27T. Record exact bytes:

```bash
zpool list -Hp -o name,size,alloc,free,health
```

### 2.5 🤖 AGENT — second `host-prepare` (Docker onto ZFS)

```bash
sudo uvx --from "$REPO" lab-agent host-prepare
```

**Assertions:**

```bash
docker info --format '{{.Driver}} {{.DockerRootDir}}'      # expect: zfs /var/lib/docker
zfs list -o name,used,quota,mountpoint fast1/docker        # quota 1T
findmnt -t zfs
systemctl is-enabled lab-storage-mounts.service            # enabled
systemctl cat lab-storage-mounts.service | grep -E 'After|Before|ExecStart'
```

**Pass:** storage-driver `zfs`, `fast1/docker` mounted at `/var/lib/docker` with a 1T quota, and
`lab-storage-mounts.service` ordered `After=zfs.target zfs-mount.service local-fs.target`,
`Before=docker.service lab-agent.service`.

### 2.6 🤖 AGENT — tier convergence with zero labs

```bash
sudo uvx --from "$REPO" lab-agent storage mount
sudo uvx --from "$REPO" lab-agent storage status
sudo uvx --from "$REPO" lab-agent storage status --json > /tmp/status-phase2.json
```

**Pass:** `fast: backend=mergerfs health=healthy path=/fast` with `fast1` and `fast2` both `ok`;
`cold: backend=zfs health=healthy path=/cold-storage`. `fast1/labs` and `fast2/labs` exist and are
mounted under `/mnt/lab-storage/`; no mergerfs mount exists yet (there are no labs).

### 2.7 🤖 AGENT — GPU node only 👤 HUMAN for the reboot
If this node has NVIDIA hardware, install and pin the driver now per `HOST_PREPARATION.md` §5, then
reboot and verify `nvidia-smi`. `host-prepare` never installs the driver. After the reboot, re-run
`host-prepare` once so CDI is regenerated and the cgroup driver pin is applied.

---

## 5. Phase 3 — Register with the controller

### 3.1 👤 HUMAN — provision the node in the UI
`https://lab.edwardcheng.net/nodes` → provision node `lab-01`. The one-time token is shown **once**.

### 3.2 👤🤖 PAIR — install the token and start

```bash
sudo uvx --from "$REPO" lab-agent set-token '<TOKEN>'
sudo uvx --from "$REPO" lab-agent start
sudo systemctl status lab-agent --no-pager
sudo journalctl -u lab-agent -n 100 --no-pager
```

**Pass:** the node shows **online** on the Nodes page within ~20 s. A close code `4001`/`4003` in
the journal means identity rejection (re-provision); a TLS or 400 error means B4 — check
`CONTROLLER_DOMAIN` and the proxy's `X-Forwarded-Host`.

### 3.3 👤🤖 PAIR — first look at the Storage page
Nodes → `lab-01` → **Manage storage** → **Refresh inventory**.

**Pass, and record screenshots:**
* Fast tier: `mergerfs`, healthy, two pools, aggregate capacity ≈ 7.24 TiB.
* Cold tier: `zfs` (Option B) or `mergerfs` (Option A), healthy, one pool ≈ 7.27 TiB.
* Docker row: `pool=fast1 dataset=fast1/docker native_zfs=true data_root=/var/lib/docker`.
* Devices table lists all three disks with by-id paths and `[fast1]` / `[fast2]` / `[cold1]`.
* Remember (§0.4): the fast capacity figure **includes** the 1 TiB Docker allowance.

### 3.4 🤖 AGENT — node health

```bash
sudo uvx --from "$REPO" lab-agent doctor
```

`doctor`'s deep checks need a running lab with a provisioned student; the storage/Docker/ZFS
portions must be clean now. Re-run doctor at the end of Phase 4.

---

## 6. Phase 4 — First labs and the quota split

### 4.1 👤 HUMAN — create two disposable labs
`/labs` → Create lab, twice: `t-alpha` and `t-bravo` (PI details can be dummy). Then on each lab
page, **Grant node access** to `lab-01`:

| Lab | Fast (TB field) | Cold (TB field) | Image | Notes |
|---|---|---|---|---|
| `t-alpha` | `1` | `2` | default | realistic-size lab |
| `t-bravo` | `0.5` | `0.5` | default | shrunk to 64 GiB in 4.2 |

The create form is in **TB with `step="0.5"`** (`labs/_components/PlacementForm.tsx`), so 0.5 TB is
the smallest value it accepts. Finer values come from the placement page in 4.2.

### 4.2 👤 HUMAN — shrink `t-bravo` to a testable size
`t-bravo` → placement → quota form (amount + unit, accepts MB/GB/TB): set **fast = 64 GB**,
**cold = 64 GB**. This form uses `amountToBytes` and accepts any positive decimal, unlike the
creation form. The controller's "GB"/"TB" are **binary** units (`QUOTA_UNIT_BYTES` in
`controller/src/lib/format.ts` is `1024**3` / `1024**4`), so 64 GB here is exactly 64 GiB and lines
up 1:1 with `zfs get quota`.

### 4.3 👤 HUMAN — add students
Add 3 members to `t-alpha` and 2 to `t-bravo` (roster import or manual). Reveal one credential to
use for the SSH tests.

### 4.4 🤖 AGENT — assert the branch split

```bash
sudo uvx --from "$REPO" lab-agent storage status --json > /tmp/status-phase4.json
zfs list -r -o name,used,quota,available,mountpoint fast1/labs fast2/labs cold1/labs
findmnt -t zfs,fuse.mergerfs
sudo getfattr --only-values -n user.mergerfs.branches /fast/t-alpha/.mergerfs; echo
sudo getfattr --only-values -n user.mergerfs.branches /fast/t-bravo/.mergerfs; echo
```

**Pass criteria — this is the core assertion of the whole plan:**

1. `fast1/labs/t-alpha` + `fast2/labs/t-alpha` quotas **sum to 1 TiB**, not double it. Expect
   roughly 512 GiB each (both pools near-empty; the 16 GiB headroom grant to each is inside the
   noise at this size).
2. `fast1/labs/t-bravo` + `fast2/labs/t-bravo` sum to 64 GiB, expect ≈ 32/32 (16 GiB headroom each,
   then ~16 GiB each from the proportional pass — B5).
3. `cold1/labs/t-alpha` quota = 2 TiB exactly (single pool → no split).
4. Two `fuse.mergerfs` mounts exist: `/fast/t-alpha`, `/fast/t-bravo` — **one per lab**, not one per
   tier. `/cold-storage/t-alpha` is a plain ZFS mount (Option B).
5. The branches xattr lists exactly `/mnt/lab-storage/fast1/labs/<lab>` and
   `/mnt/lab-storage/fast2/labs/<lab>`.
6. `mount | grep mergerfs` shows `minfreespace=53687091200`, `category.create=mfs`,
   `moveonenospc=mfs`, `cache.files=partial`, `dropcacheonclose=true`, `allow_other`, and **no**
   `use_ino`.

### 4.5 🤖 AGENT — container contract

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
docker inspect <t-alpha-container> --format '{{json .Mounts}}' | python3 -m json.tool
docker inspect <t-alpha-container> --format '{{.HostConfig.UsernsMode}} {{json .HostConfig.SecurityOpt}} {{json .HostConfig.CapAdd}} {{.AppArmorProfile}}'
```

**Pass:** mount destinations are exactly `{/home, /cold-storage, /run/labquota}`; `UsernsMode` and
`SecurityOpt` are empty, `AppArmorProfile=docker-default`, and `CapAdd` is empty. (This mirrors
`agent/tests/integration/test_real_lab.py::test_outer_boundary_and_mounts`,
which the agent can run directly:)

```bash
cd agent
LAB_INTEGRATION_CONTAINER=<container> LAB_INTEGRATION_USER=<student> \
  uv run --extra dev pytest tests/integration -q
```

### 4.6 👤 HUMAN + 🤖 AGENT — student's-eye view
👤 SSH in as a student using the revealed credential. 🤖 then asserts from the host.

```bash
# inside the lab, as the student
pwd; ls -la ~; ls -la ~/cold-storage; readlink -f ~/cold-storage
df -h ~ /cold-storage
labquota
mount | grep -E ' / | /home | /cold-storage '
nvcc --version          # GPU nodes
```

**Pass:** `/home/<user>` writable and owned by the student; `~/cold-storage` is a symlink to
`/cold-storage/<user>`; **no** `/fast`, `/cold`, `/mnt/lab-storage`, or pool name is visible
anywhere inside the container; `df` on `/home` reports the mergerfs union, not a single branch;
`labquota` prints the logical (summed) numbers, not per-branch ones.

---

## 7. Phase 5 — Data path, placement, and quota enforcement

All writes are done as a student inside `t-bravo` (64 GiB fast, ≈ 32 GiB per branch).

**Use incompressible data.** The pools are `compression=lz4`; `/dev/zero` compresses to nothing and
will not move `used` at all. Fast incompressible generator:

```bash
rnd() { openssl enc -aes-256-ctr -pass "pass:$(head -c 32 /dev/urandom | base64)" -nosalt </dev/zero 2>/dev/null; }
```

### 5.1 🤖 AGENT — files land on one branch and spread across branches

```bash
# inside the lab, as the student
for i in $(seq 1 8); do rnd | dd of=~/f$i bs=1M count=1024 iflag=fullblock status=none; done
```

Then on the host:

```bash
for p in fast1 fast2; do echo "== $p"; ls -l /mnt/lab-storage/$p/labs/t-bravo/<student>/; done
zfs list -o name,used,quota fast1/labs/t-bravo fast2/labs/t-bravo
```

**Pass:** every file exists **whole on exactly one branch** (never split, never duplicated); the 8
files are spread across both branches (`category.create=mfs` picks the branch with more free space,
so they should alternate as the branches fill); `used` on the two datasets is roughly balanced.

### 5.2 🤖 AGENT — the union reads through both branches

```bash
# inside the lab
ls ~ | sort           # all 8 files visible
md5sum ~/f1 ~/f8      # readable regardless of which branch holds them
```

### 5.3 🤖 AGENT — lab quota is a hard ceiling

```bash
# inside the lab: push past 64 GiB
for i in $(seq 9 70); do rnd | dd of=~/f$i bs=1M count=1024 iflag=fullblock status=none || { echo "FAILED at f$i"; break; }; done
du -sh ~; labquota
```

**Pass:** writes fail with *No space left on device* / *Disk quota exceeded* at ≈ 64 GiB total
(within ~1 GiB), **not** at 32 GiB and **not** at 128 GiB. `labquota` and the controller's Stats page
both report the logical total, and the sum of the two branch `used` values equals it.

### 5.4 🤖 AGENT — `moveonenospc` actually fires
Reset (`rm ~/f*`), then fill one branch deliberately and write a file that no longer fits there:

```bash
# host: watch which branch fills
watch -n2 'zfs list -o name,used,quota fast1/labs/t-bravo fast2/labs/t-bravo'
```

**Pass:** a write that begins on a nearly-full branch completes anyway, and the finished file is
found on the *other* branch. If it fails instead, record it as a finding against `moveonenospc=mfs`
(and check `mergerfs -V` — B7).

### 5.5 🤖 AGENT — per-student quota sharding
👤 On the `t-bravo` placement, enable **per-student fast quota = `0.03125` TB** (= 32 GiB; the
per-student field is in TB with `min="0.001"` and `step="any"`, so decimals are accepted) and save.
Keep it below the 64 GiB lab ceiling. 🤖 then:

```bash
zfs list -r -o name,used,quota fast1/labs/t-bravo fast2/labs/t-bravo
```

**Pass:** each student's directory is promoted to a dataset **on both branches**
(`fast1/labs/t-bravo/<user>` and `fast2/labs/t-bravo/<user>`), existing files carried across, and
their quotas sum to 32 GiB — split ≈ 16/16 (student sharding uses `min_headroom=0`, so it is a pure
proportional split). Clearing the per-student quota sets both datasets back to unlimited while the
lab quota remains the real ceiling.

### 5.6 🤖 AGENT — B6: one file cannot exceed one branch (expected failure)

```bash
# inside the lab, with the lab quota raised to 1 TB first (via the placement page)
rnd | dd of=~/huge bs=1M count=700000 iflag=fullblock status=none   # ~683 GiB, > either branch
```

**Pass (this is a *successful* test of a known limitation):** the write fails with ENOSPC even
though the lab shows ~1 TiB of headroom. Record the exact failure size. This must be communicated to
PIs — it is not a bug, it is what "a file always remains wholly on one branch" means.

### 5.7 🤖 AGENT — B9: deliberate over-commitment
👤 Raise `t-alpha` fast quota to **6 TB** while `t-bravo` holds 1 TB (sum > allocatable).
🤖 then:

```bash
sudo uvx --from "$REPO" lab-agent storage rebalance --tier fast
sudo uvx --from "$REPO" lab-agent storage status --json | python3 -m json.tool | less
```

**Pass:** the operation reports `unallocated` bytes and a warning that no branch has the physical
free space to back the remainder; the sum of branch quotas never exceeds physical capacity; no data
is deleted. Restore `t-alpha` to 1 TB afterwards.

### 5.8 🤖 AGENT — reboot survival 👤 HUMAN triggers the reboot

```bash
sudo reboot
# after it comes back:
findmnt -t zfs,fuse.mergerfs
systemctl status lab-storage-mounts.service --no-pager
docker ps
sudo uvx --from "$REPO" lab-agent storage status
```

**Pass:** both per-lab mergerfs unions are back **before** Docker started (unit ordering), all
containers are up, no lab data lives on the root filesystem
(`findmnt -T /fast/t-alpha` must show `fuse.mergerfs`, never `/`).

---

## 8. Phase 6 — Rehearsal: attach and detach a pool with no new hardware

**Why this phase exists:** it exercises `attach_pool`, the quota transfer, live branch add,
`rebalance`, and `remove-pool` on the **fast** tier (already mergerfs → no promotion, no container
restart) using a throwaway file-backed pool. It is the cheap dress rehearsal for Phase 7.
`service.inventory` lists *every* imported pool, so a file-backed pool appears in the controller's
**Attach existing pool** dropdown exactly like a real disk.

### 6.1 🤖 AGENT — create a throwaway pool

```bash
sudo mkdir -p /var/tmp/rehearsal
sudo truncate -s 200G /var/tmp/rehearsal/fast3.img
sudo zpool create -o ashift=12 -O compression=lz4 -O atime=off \
     -O xattr=sa -O acltype=posixacl -m none fast3 /var/tmp/rehearsal/fast3.img
zpool list fast3
```

> The image lives on the **boot device's** filesystem (`/var/tmp`), not on a pool. It is sparse: the
> rehearsal only creates empty datasets, so real consumption stays around a few hundred MiB of ZFS
> labels and metadata. Check `df -h /var/tmp` first — you need ~2 GiB free, not 200. Do not leave it
> in place (Phase 6.6 removes it).
>
> `minfreespace` is 50 GiB, so with a 200 GiB rehearsal pool `fast3` is still eligible for new file
> creation; that is intentional, it makes 6.4 assertion 3 meaningful.

### 6.2 🤖 AGENT — capture the "before" state

```bash
zfs get -r -o name,property,value quota fast1/labs fast2/labs > /tmp/quota-before.txt
sudo getfattr --only-values -n user.mergerfs.branches /fast/t-alpha/.mergerfs; echo
docker ps --format '{{.Names}} {{.CreatedAt}} {{.Status}}' > /tmp/containers-before.txt
```

### 6.3 👤🤖 PAIR — attach through the controller UI
👤 Storage page → Fast → **Attach existing pool** → `fast3` → submit. (The equivalent CLI is
`sudo lab-agent storage add-pool --tier fast --pool fast3`; use the UI here because the UI path is
what production will use.)

### 6.4 🤖 AGENT — assert the attach was quota-neutral and non-disruptive

```bash
sudo uvx --from "$REPO" lab-agent storage status --json > /tmp/status-phase6.json
zfs get -r -o name,property,value quota fast1/labs fast2/labs fast3/labs
sudo getfattr --only-values -n user.mergerfs.branches /fast/t-alpha/.mergerfs; echo
docker ps --format '{{.Names}} {{.CreatedAt}} {{.Status}}'
```

**Pass:**
1. Every lab now has a third branch `fast3/labs/<lab>`.
2. Per lab, **sum of branch quotas is unchanged** (still 1 TiB for `t-alpha`) — donors were shrunk
   before the new branch was created, never the other way round.
3. `t-alpha`'s branch list now includes `/mnt/lab-storage/fast3/labs/t-alpha`.
4. **Container `CreatedAt` and `Status` uptime are unchanged** — `attached_live: true`,
   `restart_required: false` in the task result. A restart here is B10 and must be recorded.
5. No file moved: `ls` output on the fast1/fast2 branch directories is identical to 6.2.
6. `/etc/lab-agent/config.toml` now lists `pools = ["fast1", "fast2", "fast3"]`.
7. The controller's Tasks page shows the `storage.attach_pool` task as done with a per-lab result.

### 6.5 🤖 AGENT — rebalance behaviour and the deadband

```bash
sudo uvx --from "$REPO" lab-agent storage rebalance --tier fast --min-delta-gb 0     # exact re-slice
zfs get -r -o name,property,value quota fast1/labs fast2/labs fast3/labs
sudo uvx --from "$REPO" lab-agent storage rebalance --tier fast --min-delta-gb 100   # deadband
```

**Pass:** the exact re-slice moves quota toward the emptiest pool and the per-lab sum is still
unchanged; the deadband run reports labs as *unchanged* and rewrites nothing (all-or-nothing per lab
— `quota.plan_steps`).

### 6.6 👤🤖 PAIR — detach and clean up

```bash
sudo uvx --from "$REPO" lab-agent storage remove-pool --tier fast --pool fast3 --confirm
sudo uvx --from "$REPO" lab-agent storage rebalance --tier fast
sudo uvx --from "$REPO" lab-agent storage status
docker ps --format '{{.Names}} {{.CreatedAt}} {{.Status}}'
```

Then, only after confirming no lab data is on it:

```bash
sudo zpool destroy fast3
sudo rm -f /var/tmp/rehearsal/fast3.img
sudo uvx --from "$REPO" lab-agent storage mount
```

**Pass:** without `--confirm` the removal is **refused** and names the labs holding data (try it
first, deliberately). With `--confirm` the branch leaves the union, the released quota becomes
available to the survivors on the next rebalance, no dataset is destroyed by the agent, and any lab
that needed a remount was restarted automatically and reported. Config returns to
`pools = ["fast1", "fast2"]`.

---

## 9. Phase 7 — Add the second 8 TB HDD (the real upgrade)

Run this **only** after Phase 6 passed. This is the B2 path.

### 7.0 👤 HUMAN — pre-flight for the promotion

* Announce a maintenance window: **every lab container on this node will restart.**
* Confirm no admin shell, rsync, backup job, or SSH session is inside `/cold-storage`:
  ```bash
  sudo fuser -vm /cold-storage        # must be empty apart from the container processes
  sudo lsof +D /cold-storage | head
  ```
* 🤖 assert B3 — every placement has a finite cold quota:
  ```bash
  sudo uvx --from "$REPO" lab-agent storage status --json \
    | python3 -c 'import json,sys; s=json.load(sys.stdin)["state"]["labs"]["cold"]; print({k: v.get("configured_quota_bytes") for k,v in s.items()})'
  ```
  Any `None` → set that lab's cold quota in the UI **before** proceeding.
* 🤖 capture the rollback reference:
  ```bash
  zfs get -r -o name,property,value mountpoint,quota cold1 > /tmp/cold-before.txt
  docker ps --format '{{.Names}} {{.CreatedAt}}' > /tmp/containers-before-phase7.txt
  sudo cp /etc/lab-agent/config.toml /root/config.toml.pre-cold2
  ```
* 👤 **Back up anything on cold you are not willing to lose**, even though this operation moves no
  data. The rollback path is tested but the failure mode (`MANUAL RECOVERY NEEDED`) is manual.

### 7.1 👤 HUMAN — install HDD-2, then 🤖 identify it

```bash
sudo uvx --from "$REPO" lab-agent storage devices
```

If it shows as in use, wipe it as in §2.3 (B1) — otherwise it will not appear in the UI picker.

### 7.2 👤🤖 PAIR — initialize it as `cold2`
Storage page → Cold → **Initialize disk** → pick the by-id path → pool name `cold2` → read and accept
the destructive warning.

This enqueues `storage.create_pool` with `confirm: true`, `force: false`, `vdev_type: ""` and then
attaches it to the cold tier in the same task.

CLI equivalent if the UI path is blocked:

```bash
sudo zpool create -o ashift=12 -O compression=lz4 -O atime=off \
     -O xattr=sa -O acltype=posixacl -m none cold2 /dev/disk/by-id/<HDD2>
sudo uvx --from "$REPO" lab-agent storage add-pool --tier cold --pool cold2
```

### 7.3 🤖 AGENT — assert the promotion

```bash
sudo uvx --from "$REPO" lab-agent storage status --json > /tmp/status-phase7.json
grep -A6 '\[storage.cold\]' /etc/lab-agent/config.toml
zfs get -r -o name,property,value mountpoint,quota cold1 cold2
findmnt -t zfs,fuse.mergerfs | grep -E 'cold|lab-storage'
sudo getfattr --only-values -n user.mergerfs.branches /cold-storage/t-alpha/.mergerfs; echo
docker ps --format '{{.Names}} {{.CreatedAt}} {{.Status}}'
```

**Pass:**
1. Config now reads `backend = "mergerfs"`, `pools = ["cold1", "cold2"]`, `branch_root = "/mnt/lab-storage"`.
2. `cold1/labs` and `cold1/labs/<lab>` mountpoints moved to `/mnt/lab-storage/cold1/labs/...`;
   `cold2/labs/<lab>` created there too.
3. **Per-lab cold quota sum is unchanged** — `t-alpha` still totals 2 TiB across the two branches,
   NOT 4 TiB. This is the single most important assertion in this phase.
4. `/cold-storage/<lab>` is now a `fuse.mergerfs` mount with both branches in the xattr.
5. Containers were stopped and started (their `CreatedAt` is unchanged — recreated would be a bug —
   but uptime resets). The task result lists `promoted_to_mergerfs: true`,
   `restart_required: [t-alpha, t-bravo]`, `containers_restarted: [...]`, and
   `container_restart_errors: []`.
6. `PARTIAL — branches were not added for: ...` in the task note is a **failure**; investigate B3.

### 7.4 👤 HUMAN + 🤖 AGENT — data survived the promotion
👤 SSH in as the same student used in Phase 5.

```bash
# inside the lab
ls -la /cold-storage/$USER
md5sum /cold-storage/$USER/<a file written in Phase 5>     # compare to the pre-promotion hash
df -h /cold-storage
labquota
```

**Pass:** identical paths, identical hashes, identical logical quota. Nothing inside the container
mentions `cold1`, `cold2`, or `/mnt/lab-storage`.

### 7.5 🤖 AGENT — new writes reach the new disk

```bash
# inside the lab
for i in $(seq 1 6); do rnd | dd of=/cold-storage/$USER/c$i bs=1M count=2048 iflag=fullblock status=none; done
# host
zfs list -o name,used,quota cold1/labs/t-alpha cold2/labs/t-alpha
ls /mnt/lab-storage/cold2/labs/t-alpha/<student>/
```

**Pass:** new files land predominantly on `cold2` (`category.create=mfs` → most free space), old
files stay where they were, and the union shows all of them.

### 7.6 👤🤖 PAIR — raise the cold quota into the new capacity
👤 Raise `t-alpha` cold to 8 TB (now that the tier has ~14 TiB). 🤖 assert the split lands roughly
proportional to each pool's free space and the sum equals 8 TiB.

---

## 10. Phase 8 — Docker-skew and the rebalance scheduler

### 8.1 🤖 AGENT — prove the fast split follows live free space

```bash
# consume ~300 GiB of real space on fast1 (compression OFF so /dev/zero actually allocates blocks;
# with the pool's inherited lz4 it would compress away and free space would not move at all)
sudo zfs create -o compression=off -o mountpoint=/mnt/ballast fast1/ballast
sudo dd if=/dev/zero of=/mnt/ballast/fill bs=1M count=307200 status=progress
zpool list -o name,size,alloc,free fast1 fast2

sudo uvx --from "$REPO" lab-agent storage rebalance --tier fast --min-delta-gb 0
zfs get -r -o name,property,value quota fast1/labs fast2/labs
```

**Pass:** after the rebalance each lab's `fast2` branch quota has **grown** and its `fast1` branch
has **shrunk**, with the per-lab sum unchanged; no file moved; the operation took seconds (it only
rewrites ZFS properties). Then clean up:

```bash
sudo zfs destroy fast1/ballast
sudo rmdir /mnt/ballast 2>/dev/null
sudo uvx --from "$REPO" lab-agent storage rebalance --tier fast --min-delta-gb 0
```

### 8.2 🤖 AGENT — quotas never shrink below used data

```bash
# with t-bravo already holding ~30 GiB on fast1:
# 👤 lower t-bravo's fast quota in the UI to 16 GB (below what is on disk)
sudo uvx --from "$REPO" lab-agent storage status --json | grep -i over_commit -A3
zfs get -o name,property,value quota fast1/labs/t-bravo fast2/labs/t-bravo
```

**Pass:** the operation reports **over-committed** with a clear warning, branches are pinned at
exactly their current usage, **no data is deleted**, and the controller surfaces the error on the
placement page rather than silently succeeding. Restore the quota afterwards.

### 8.3 👤🤖 PAIR — the scheduled rebalance
👤 Settings → Storage quota rebalance: enable, interval **1 hour**, deadband **1 GB**.
🤖 wait for one tick (or restart the controller to force the ticker) and then:

```bash
# controller host
docker compose logs controller --since 90m | grep -i rebalance
# node
sudo journalctl -u lab-agent --since '90 min ago' | grep -i rebalance
```

**Pass:** exactly one `storage.rebalance` task per online ZFS node per interval, carrying
`min_delta_bytes = 1073741824`; quiet runs report *unchanged* and write nothing; the per-node
Storage page button still forces an exact re-slice (`min_delta_bytes: 0`). Then 👤 set it back to
**off** or to a 24 h interval for production.

---

## 11. Phase 9 — Degraded operation and recovery

This is the phase that tells the human what a real disk failure will look like. Do it on `cold2`
(after Phase 7) or on a rehearsal pool if HDD-2 was never installed.

### 9.1 🤖 AGENT — simulate the disk disappearing

```bash
docker stop <t-alpha-container> <t-bravo-container>
sudo uvx --from "$REPO" lab-agent storage unmount
sudo zpool export cold2
sudo uvx --from "$REPO" lab-agent storage mount
docker start <t-alpha-container> <t-bravo-container>
sudo uvx --from "$REPO" lab-agent storage status
sudo getfattr --only-values -n user.mergerfs.branches /cold-storage/t-alpha/.mergerfs; echo
```

**Pass:**
1. The cold tier reports **degraded**, `cold2` shows `UNUSABLE`, and the Nodes/Storage page agrees.
2. The union came up with **only** `cold1` in the branch xattr — no empty root-filesystem directory
   was used as a branch.
3. Files that live on `cold1` are still readable and writable from inside the lab; files that lived
   on `cold2` are simply absent (not corrupt, not zero-length).
4. `zfs get quota cold1/labs/t-alpha` is **unchanged** — survivors did **not** inherit the missing
   branch's allocation.

### 9.2 🤖 AGENT — the safety interlocks hold while degraded

```bash
sudo uvx --from "$REPO" lab-agent storage rebalance --tier cold
```
**Pass:** the report includes *"N branch(es) unavailable (cold2); X bytes of quota stay reserved for
them"* and the reserved bytes are held back from the budget.

👤 Attempt to **remove the `t-bravo` placement** (destructive lab removal) from the controller.
**Pass:** it is refused/blocked while a branch is missing, with a message naming the missing pool.
Do not force it.

### 9.3 🤖 AGENT — recovery

```bash
sudo zpool import cold2
sudo uvx --from "$REPO" lab-agent storage mount
sudo getfattr --only-values -n user.mergerfs.branches /cold-storage/t-alpha/.mergerfs; echo
sudo uvx --from "$REPO" lab-agent storage status
```

**Pass:** the branch returns, its files reappear at their original paths, the tier is `healthy`
again, and quotas are exactly what they were before 9.1. Verify hashes of two files that lived on
`cold2`.

### 9.4 🤖 AGENT — total loss of one tier

```bash
docker stop <containers>; sudo uvx --from "$REPO" lab-agent storage unmount
sudo zpool export cold1; sudo zpool export cold2
sudo uvx --from "$REPO" lab-agent storage mount
findmnt /cold-storage/t-alpha ; echo "exit=$?"
```

**Pass:** the logical mount is deliberately **left down** — `/cold-storage/t-alpha` is not a mount
point, so a container write cannot fall through onto the root filesystem. Re-import both pools and
`storage mount` to recover.

### 9.5 🤖 AGENT — scrub

```bash
sudo uvx --from "$REPO" lab-agent storage status --json | grep -i scrub -A4
# 👤 or: Storage page -> per-pool "Scrub"
zpool status -v
```

**Pass:** scrubs start on each owned pool, progress and last-scrub time appear on the Storage page.
👤 Note: on these single-disk pools a scrub **detects** errors but cannot repair them.

---

## 12. Phase 10 — Reset to the production baseline

### 10.1 👤🤖 PAIR — remove the test labs
👤 Delete `t-alpha` and `t-bravo` from the controller (this removes accounts, homes, and cold data on
this node). 🤖 then confirm:

```bash
zfs list -r fast1/labs fast2/labs cold1/labs cold2/labs
findmnt -t fuse.mergerfs
docker ps -a
ls /mnt/lab-storage/*/labs/
```

**Pass:** no `t-alpha`/`t-bravo` datasets, no leftover mergerfs mounts, no leftover containers, no
orphan directories under `/mnt/lab-storage`.

### 10.2 🤖 AGENT — confirm nothing test-only remains

```bash
zpool list                                # only fast1, fast2, cold1[, cold2]
zfs list -r fast1 fast2 cold1 cold2 | grep -Ei 'ballast|rehearsal|fast3'   # expect nothing
ls /var/tmp/rehearsal 2>/dev/null          # expect: no such directory
cat /etc/lab-agent/config.toml
sudo uvx --from "$REPO" lab-agent storage status
sudo uvx --from "$REPO" lab-agent doctor
```

### 10.3 👤 HUMAN — production settings
* Docker quota (`quota_gb`) final value; re-run `host-prepare` if changed.
* Scheduled rebalance: enabled or off, interval, deadband.
* Default fast/cold quotas in Settings (shipped defaults are 2 TiB / 3 TiB — likely too large for
  this node's 6.1 TiB fast budget if you expect more than 3 labs).
* Backup policy for cold — **required**, because §0.2 accepted zero redundancy.
* Pin the controller image to a digest rather than `:latest` (see `docker-compose.yml`).

### 10.4 👤🤖 PAIR — sign-off
Produce the evidence log (§13) and have the human sign off on each phase's pass/fail.

---

## 13. Evidence log template 🤖 AGENT maintains

Record for every phase: timestamp, exact command, exit code, verbatim output, pass/fail, and any
deviation. Minimum artefacts to keep:

| Artefact | When |
|---|---|
| `zpool list -Hp -o name,size,alloc,free,health` | after 2.4, after 7.2 |
| `lab-agent storage status --json` | phases 2, 4, 6, 7, 9 (before and after each mutation) |
| `zfs get -r quota,used,mountpoint <pools>` | before and after every attach/detach/rebalance |
| `getfattr --only-values -n user.mergerfs.branches <mount>/.mergerfs` | every union change |
| `docker ps --format '{{.Names}} {{.CreatedAt}} {{.Status}}'` | before and after every attach/detach |
| md5sums of 3 known files | before and after the Phase 7 promotion, and around Phase 9 |
| Controller Tasks page task IDs + results | every `storage.*` task |
| Screenshots of the Storage page | phases 3, 4, 7, 9 |

## 14. Command cheat-sheet

```bash
REPO="git+https://github.com/EC061/docker-mass-deployment.git#subdirectory=agent"
sudo uvx --from "$REPO" lab-agent storage status [--json]
sudo uvx --from "$REPO" lab-agent storage devices
sudo uvx --from "$REPO" lab-agent storage mount            # idempotent convergence
sudo uvx --from "$REPO" lab-agent storage unmount
sudo uvx --from "$REPO" lab-agent storage add-pool    --tier {fast|cold} --pool NAME
sudo uvx --from "$REPO" lab-agent storage remove-pool --tier {fast|cold} --pool NAME [--confirm]
sudo uvx --from "$REPO" lab-agent storage rebalance   [--tier {fast|cold}] [--min-delta-gb N]
sudo uvx --from "$REPO" lab-agent doctor
sudo uvx --from "$REPO" lab-agent host-prepare
```

Everything above works with the controller offline — that is deliberate, and it is your recovery
path if `lab.edwardcheng.net` is unreachable during an incident.
