# Multi-Drive Test Run — execution log (node `geass`, controller `lab.edwardcheng.net`)

Live log for the run of `MULTI_DRIVE_TEST_PLAN.md`. Updated as work proceeds so a session
interruption never loses state. Commit SHA under test: `0162b15` (branch
`t3code/multi-drive-test-plan`; all storage commits are in `origin/main` @ `9a03e54`).

## Environment as found (2026-08-30)

| | |
|---|---|
| Node | `geass` / `geass.cs.uga.edu` (172.22.162.83), Ubuntu 24.04.4, kernel **7.0.0-30-generic** (HWE) |
| Access | Duo-gated. Driving the operator's Terminal.app window (root via `sudo -i`) through `/tmp/geass-harness/g.sh` |
| GPU | 4 × NVIDIA RTX A6000 (49 GiB each), driver 580.173.02, CUDA 13.0 — already installed, no reboot needed |
| Controller | `https://lab.edwardcheng.net` → 150.136.85.210. Admin `edwardcheng@uga.edu`. Current image **has** the rebalance scheduler |
| Boot device | `nvme1n1` 953.9 G SOLIDIGM — `/` + `/boot/efi`. **Separate from all three data drives → blocker B0 resolved, §0.1.1 option (a)** |
| SMTP | Configured, 2 ranked configs, From `Lab Cluster Admin <no-reply@edwardcheng.net>` |
| Mailboxes | PI `ningxicheng111@gmail.com` (Chrome profile `u/2`), student `ningxicheng112@gmail.com` (`u/0`) |

### Target drives

| Planned pool | Device | by-id | Currently |
|---|---|---|---|
| `fast1` | `nvme2n1` 3.6 T Samsung 990 PRO | `nvme-Samsung_SSD_990_PRO_4TB_S7KGNJ0WC05103N` | `/nvme_data1` xfs, **3.5 T used (96 %)** — Docker data-root + old `docker-mass-deployment` |
| `fast2` | `nvme0n1` 3.6 T Samsung 990 PRO | `nvme-Samsung_SSD_990_PRO_4TB_S7KGNJ0WC05106Z` | `/nvme_data2` xfs, **3.4 T used (94 %)** — `class_data`, six users |
| `cold1` | `sda` 7.3 T TOSHIBA MG08ADA800E | `ata-TOSHIBA_MG08ADA800E_5460A079FCXH` | `/data1` xfs, **0 bytes — genuinely empty** |

## Deviations from the plan, agreed with the operator

1. **No reboots.** NVIDIA driver already present, so §2.7 needs no install. **Phase 5.8 (reboot
   survival) is deferred** to the end and requires the operator (SSH master dies, Duo re-auth).
2. **Phase 7 uses a file-backed `cold2`** (only one 8 TB HDD exists). Still exercises the real
   `zfs → mergerfs` promotion and container-restart path (blocker B2).
3. **Node name `geass`**, alias `geass.cs.uga.edu`. `NODE_NAME_RE` (`controller/src/lib/nodes.ts:26`)
   forbids dots, so the FQDN cannot be the node name.
4. **Welcome email template must use `{host_alias}`, not `{host}`.** `placements.ts:439` sets `host`
   from `node_name`; only `{host_alias}` carries the alias. Without this students receive an
   unconnectable `ssh user@geass -p 5000x`. Template is global — revert at Phase 10 if wanted.
5. **Pseudo roster via Gmail plus-addressing** (`ningxicheng112+a1@gmail.com` …) — two real
   mailboxes, five accounts needed.
6. **Cold tier starts `backend = "zfs"`** (DECISION 2, Option B) so Phase 7 can test the promotion.

## Phase 0 — Pre-flight

- [x] **0.1a** Agent lint — `ruff check src tests` → *All checks passed!*
- [x] **0.1b** Agent unit tests — `pytest -q` → **488 passed, 5 skipped** in 0.86 s
- [x] **0.1c** Controller — `typecheck` clean, `lint` clean (`--max-warnings=0`), `vitest run` **345 passed / 39 files**, `next build` succeeded
- [x] **0.2** Blockers re-verified against the tree (see below)
- [x] **0.3** Controller readiness — admin login OK, rebalance settings present
- [x] **0.4** Disk serials recorded (table above)

### Blocker re-verification (§0.2)

| ID | Status against `0162b15` |
|---|---|
| B0 | **Resolved** — separate 953 G boot NVMe |
| B1 | **Holds and is live** — all three drives carry mounted XFS; none will appear in the UI picker until wiped |
| B2 | Holds — `storageops.attach_pool` stops managed containers before the cold promotion |
| B3 | Holds — assert finite `cold_quota_bytes` before Phase 7 |
| B4 | Holds — `wss://` only; proxy must forward `X-Forwarded-Host` |
| B5–B11 | Hold as written |
| **B13 (NEW)** | **ZFS userland/kernel version split — see below** |

### B13 (new blocker, resolved) — kernel ships OpenZFS 2.4.1, apt only offers 2.2.2

`linux-modules-7.0.0-30-generic` ships `zfs.ko` at **2.4.1-1ubuntu5**, but `noble`/`noble-updates`
only carry `zfsutils-linux` **2.2.2**, which is what `host-prepare` would have installed — a
userland/kernel split across two minor versions on the box the whole storage feature is being
tested on.

**Fix applied:** installed the matching 2.4.1-1ubuntu5 userland from the shared Ubuntu pool
(`zfsutils-linux`, `libzfs7linux`, `libzpool7linux`, `libnvpair3linux`, `libuutil3linux`); all
dependencies satisfiable on noble (glibc 2.39 ≥ 2.38, libssl3t64 3.0.13). Then `apt-mark hold` on
all five so nothing downgrades them.

```
zfs version → zfs-2.4.1-1ubuntu5 / zfs-kmod-2.4.1-1ubuntu5   # matched
```

**This belongs in `HOST_PREPARATION.md` as a permanent note** — any node on the HWE 7.x kernel hits
it, and `host-prepare` will silently install the mismatched 2.2.2.

## Phase 1 — Node bootstrap

- [x] ZFS userland installed and version-matched (B13)
- [ ] `lab-agent install`
- [ ] `/etc/lab-agent/config.toml` written
- [ ] first `host-prepare`
- [ ] `mergerfs -V` recorded (B7 — must be ≥ 2.35)

## Phase 2 — Create the pools (DESTRUCTIVE) — **BLOCKED, see below**

- [x] **2.1 operator confirmation — given** (see decision record below)
- [ ] 2.3 wipe, 2.4 create `fast1`/`fast2`/`cold1`, 2.5 second `host-prepare`, 2.6 convergence

## Phases 3–10

Not started. See `MULTI_DRIVE_TEST_PLAN.md` §5–§12 for the full step list.

---

## Destructive-wipe decision (recorded)

The two SSDs were **not** empty when checked. The operator was shown the full detail below and
**explicitly reaffirmed "wipe everything now — it is all expendable"** on 2026-08-30. Proceeding on
that instruction. A manifest of everything destroyed is at `/root/evidence/00-destroyed-manifest.txt`
on the node.

### What was destroyed (captured 2026-08-30 03:4x, before the wipe)

**`/data1` (8 TB HDD → `cold1`) is genuinely empty — 0 bytes. Safe to wipe now.**

**`/nvme_data2` (→ `fast2`) holds 3.4 TB of other people's work**, `class_data/`:
`manual_chence`, `manual_edward`, `manual_sreeja.muvva`, `manual_tao`, `manual_z44375`,
`team_15` (owned by `gy23443`). Files were modified **today** — commits landed in
`manual_chence/workspace/Cmp4ai/.git` on 2026-08-30.

**Someone is working in it right now.** The `manual_chence` container (privileged, 156 GB image)
has a live VS Code server and **two running `claude` processes**, the newer started
2026-08-29 23:36. Their cwd is `/data/workspace`, i.e. the bind mount from `class_data/manual_chence`.

**`/nvme_data1` (→ `fast1`) is Docker's data-root** (3.5 TB) — it holds the container filesystems of
all five running containers (`manual_sreeja.muvva`, `manual_z44375`, `manual_chence`,
`manual_edward`, `team_15`, ports 50000-50003/50050), plus a git checkout of the previous
`docker-mass-deployment` manual system.

Wiping either SSD destroys live user data and kills five running sessions. **Operator confirmed
after being shown all of the above.**

---

# BUGS FOUND (all reproduced on real hardware, all fixed in this worktree)

Three defects, two of them blocking, none of which had test coverage. All were invisible to the
mocked unit suites (`agent/tests/fakezfs.py` never remounts; the controller has no storage-page
render test).

## BUG-1 🔴 The second and every later lab on a multi-pool tier fails to provision

**`agent/src/lab_agent/executors/zfs.py` — `create_dataset`**

On an already-existing dataset, `create_dataset` unconditionally ran
`set_property(name, "mountpoint", mountpoint)` even when the mountpoint was **already exactly that
value**. `zfs set mountpoint` unmounts and remounts the dataset, which fails as soon as a child
dataset is mounted beneath it.

`service.py:154` calls `create_dataset(<tier root>, mountpoint=...)` on every `lab.create`. So:

1. `t-bravo` provisioned first → `fast1/labs/t-bravo` mounted under `/mnt/lab-storage/fast1/labs`.
2. `t-alpha` provisioned second → re-assert of `fast1/labs`'s own mountpoint →
   `cannot unmount '/mnt/lab-storage/fast1/labs': pool or dataset is busy` → `lab.create` **failed**.
3. Every `t-alpha` `student.add` then failed with
   *"no fast branch of lab 't-alpha' is mounted; refusing to create student storage"*.

The first lab on a node always works; the second never does. This is the headline multi-drive
scenario, so it would have hit production on day one.

**Fix:** only set the mountpoint when it genuinely differs. Regression tests
`test_create_dataset_does_not_remount_an_already_correct_mountpoint` and
`test_create_dataset_moves_a_genuinely_different_mountpoint`.

## BUG-2 🔴 No student credential can ever be verified — the agent's askpass is on a noexec mount

**`agent/src/lab_agent/executors/users.py` — `verify_ssh_login`**

`containerops` mounts the container's `/run` as a tmpfs (`HostConfig.Tmpfs =
{"/run":"rw,nosuid,nodev", ...}`). **Docker applies `noexec` to tmpfs mounts unless told
otherwise.** `verify_ssh_login` then wrote its `SSH_ASKPASS` helper to
`/run/lab-agent-askpass.XXXXXX`, chmod 0700, and asked ssh to exec it:

```
ssh_askpass: exec(/run/lab-agent-askpass.QMMjUZ): Permission denied
sbravo1@127.0.0.1: Permission denied (publickey,password).
```

Reproduced directly in the container: writing a 0700 script to `/run` and running it gives
*Permission denied*; `/tmp`, `/root` and `/var/tmp` all give `EXEC_OK`.

The two halves of the agent contradict each other. Because a member only becomes `active` after
this SSH proof, **no credential email is ever sent and no placement ever completes** — on any node,
for any lab. Accounts, passwords, homes, sudo and `PasswordAuthentication yes` were all verified
correct; only the exec of the askpass helper failed.

**Fix:** create the helper in a private 0700 directory under `/var/tmp` (container rootfs, exec-
able) instead of `/run`. Regression test
`test_verify_ssh_login_askpass_is_not_on_the_noexec_run_tmpfs`.

## BUG-3 🟠 Node Storage page overstates every size by 1024×

**`controller/src/app/(app)/nodes/[name]/storage/page.tsx:42`** (introduced by `8597702`)

The page's own `fmtBytes` has `const units = ["B", "KiB", "GiB", "TiB", "PiB"]` — **`MiB` is
missing**, so every value ≥ 1 MiB is labelled one unit too high. The 7.25 TiB fast tier rendered as
**“7.3 PiB”**; each 3.62 TiB pool as “3.6 PiB”.

This is the page §0.4 of the plan tells the operator to size lab quotas from. `lib/format.ts`
`fmtBytes` is correct; only this local duplicate is wrong.

**Fix:** add the missing `MiB`.

# OPERATIONAL FINDINGS (no code change made)

## FIND-1 🟠 Failed placement members can never be retried from the UI
When `lab.create` fails, the placement page offers **Retry provisioning**. When the placement is
`active` but individual `student.add` tasks failed, there is **no retry affordance at all** — and
"Retry provisioning" (used on `t-alpha`) re-ran `lab.create` **without** re-running the failed
members, leaving them stranded on the old error. The PI row is *protected*, so it cannot even be
removed and re-added. The only remedy is **Remove access + re-grant**, which destroys the lab's
storage on that node. Recommend a per-member retry, or having placement retry re-dispatch
`student.add` for members not in `active`.

## FIND-2 🟠 Removing a placement leaves orphan mountpoint directories
After **Remove access** for both labs, datasets, containers and unions were all correctly gone, but
empty directories remained at `/mnt/lab-storage/fast1/labs/{t-alpha,t-bravo}`,
`/mnt/lab-storage/fast2/labs/{...}` and `/cold-storage/{...}`. Plan §10.1 requires *"no orphan
directories under /mnt/lab-storage"*. It also rubs against `MountState`'s own stated threat model —
an empty leftover directory is exactly what that guard exists to distinguish from a real mount.

## FIND-3 🟡 mergerfs from apt is 2.33.5 — below the 2.35 the code requires (blocker B7, confirmed)
`host-prepare` installs noble's `mergerfs` **2.33.5**. The code relies on the `user.mergerfs.branches`
runtime xattr and omits `use_ino` (removed in 2.35). Upgraded to upstream **2.42.0** and
`apt-mark hold`ed. `host-prepare` should either require ≥ 2.35 or install the upstream .deb.

## FIND-4 🟡 Admin pages show the node name where students need the alias
The placement page prints `ssh -p 50001 <user>@geass`. `geass` is not resolvable; only the alias
`geass.cs.uga.edu` is. The *welcome email* correctly uses `{host_alias}` (already customised), so
students are fine — but an admin copying the command off the placement page gets a dead host.

# EVIDENCE — Phase 4 branch split (the plan's core assertion) ✅

Captured with both labs provisioned, before the re-grant:

```
fast1/labs/t-alpha   512G      fast2/labs/t-alpha   512G   -> 1 TiB total, NOT 2 TiB   ✅
fast1/labs/t-bravo   256G      fast2/labs/t-bravo   256G   -> 512 GiB total            ✅
cold1/labs/t-alpha     2T                                   single pool, no split      ✅
cold1/labs/t-bravo   512G                                   single pool, no split      ✅
```

Per-lab mergerfs union at `/fast/<lab>` (one per lab, not one per tier) ✅

## FIND-5 🔴 Nested bubblewrap PID sandboxes cannot work on GPU nodes

`lab-agent doctor` reports this itself once a lab is running:

```
'bwrap_ok': False
health: critical — bubblewrap_failed:
  "Distribution /usr/bin/bwrap cannot create a user/PID/proc sandbox"  (repairable: True)
```

Isolated inside `t-alpha-geass` as the student `salpha1`:

| # | command | result |
|---|---|---|
| A | `bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid` | **FAIL** — `Can't mount proc on /newroot/proc: Operation not permitted` |
| B | `bwrap ... --bind /proc /proc --unshare-pid` | OK |
| C | `bwrap ... --proc /proc` (no `--unshare-pid`) | **OK** |
| D | `bwrap ... --unshare-pid --unshare-user` (no proc) | OK |
| E | `bwrap ... --tmpfs /tmp --unshare-pid` | OK |

Only the **combination** of a fresh procfs and a new PID namespace fails — i.e. exactly
`system.py:510-513`, the agent's own smoke test, and the nested-Codex sandbox the image exists for.

**Cause.** A new PID namespace forces a new procfs *superblock*, which makes the kernel apply
`mount_too_revealing()`: it refuses the mount if the procfs already visible to the caller has
anything mounted over a subdirectory. Inside the container there is exactly one such overmount:

```
tmpfs /proc/driver/nvidia/params tmpfs rw,relatime,size=4k,inode64
```

The **host has no such mount** — it is injected by the NVIDIA container runtime. It is not in
`/etc/cdi/nvidia.yaml`, so it comes from the legacy `nvidia-container-runtime` hook that
`daemon.json` still registers (`runtimes.nvidia`), even though CDI is generated and working
(`cdi_ok: True`, `nvidia.com/gpu=0..3` present).

This is not caused by the container contract, which is correct: `MaskedPaths=[]`,
`ReadonlyPaths=[]` (i.e. `systempaths=unconfined` applied), `CapAdd` empty, `Privileged=false`,
`UsernsMode=host`, `apparmor=lab-codex` + seccomp.

**Suggested fix:** inject GPUs via **CDI only** (`--device nvidia.com/gpu=all`) and stop using the
legacy `nvidia` OCI runtime for lab containers, so no tmpfs is overmounted inside `/proc`.

**Also:** the issue is flagged `repairable: True`, but `maintenance.run_repair` only chmods the
seccomp profile, reloads AppArmor and regenerates CDI — **none of which can fix this**. The repair
button will appear to run successfully and change nothing.

## FIND-6 🟡 Pool names leak into the container's mount table
Plan §4.6 requires that no pool name be visible inside the lab. Paths are correctly hidden
(`/fast`, `/cold`, `/mnt/lab-storage` all absent), but `mount` inside the lab shows dataset
*sources*:

```
fast1/docker/c177...  on /              type zfs
cold1/labs/t-alpha    on /cold-storage  type zfs
fast1/docker          on /etc/resolv.conf, /etc/hostname, /etc/hosts
```

The fast tier is clean (`lab-fast-t-alpha`, a synthetic mergerfs source). Cold is exposed because
it is native ZFS (DECISION 2 Option B) and will stop leaking once Phase 7 promotes it to mergerfs;
`/` will always show `fast1/docker/<id>` because that is Docker's ZFS storage driver. Information
disclosure only — no data is reachable — but the plan's stated criterion is not met.

## FIND-7 🟡 Welcome email advertises a `~/scratch` directory that does not exist
The customised template says `~/scratch  fast storage for working data`. Confirmed inside the lab:
`ls: cannot access '/home/salpha1/scratch': No such file or directory`. The shipped default
(`settings.ts:DEFAULT_WELCOME_BODY`) correctly says `~`, and README states no `~/scratch` exists.
Every student receives instructions for a path that isn't there. Fix the template text.

# EVIDENCE — Phase 4 verified end to end ✅

* Both labs provisioned cleanly after the fixes; **t-bravo re-provisioned as the *second* lab**,
  the exact case BUG-1 broke.
* All 4 `t-alpha` members `active`, credentials **delivered by email**.
* Real student SSH login from off-node using the emailed command:
  `ssh salpha1@geass.cs.uga.edu -p 50000` ✅
* `df ~` inside the lab reports the **logical union** `lab-fast-t-alpha 1.0T`, not a 512 G branch ✅
* `labquota` reports logical totals `1.0 TiB fast / 2.0 TiB cold / 300 GiB rootfs` ✅
* `~/cold-storage -> /cold-storage/salpha1` symlink ✅
* §4.5 container contract: mounts exactly `{/home, /cold-storage, /run/labquota(ro)}`,
  `UsernsMode=host`, `CapAdd` empty, seccomp + `apparmor=lab-codex`, `systempaths=unconfined` ✅
* 4 × RTX A6000 visible in the lab, `nvcc` 13.3 works ✅

## BUG-4 🔴 `minfreespace` is a flat 50 GiB, so small labs lose most (or all) of their quota

**`agent/src/lab_agent/storage/model.py:132` — `DEFAULT_MINFREESPACE = 50 * GIB`**

mergerfs's create policy skips any branch with less than `minfreespace` free. The value is a
**flat constant, independent of the lab's per-branch quota**, and each branch's "free space" is
bounded by that branch's ZFS quota. So on a 2-branch fast tier every lab silently loses
**2 × 50 GiB = 100 GiB** of the quota it was granted.

### Measured on real hardware

`t-bravo`, fast quota **64 GB** (= 32 GiB per branch), **completely empty**:

```
dd: failed to open '/home/sbravo1/f1': No space left on device
```

Not one byte could be written. A/B against `t-alpha` (512 GiB per branch) at the same moment:

```
/mnt/lab-storage/fast1/labs/t-bravo   34357510144  free  -> below minfreespace -> CREATE FAILS
/mnt/lab-storage/fast1/labs/t-alpha  549712691200  free  -> above minfreespace -> CREATE OK
```

Then with `t-bravo` raised to **128 GB** (64 GiB per branch):

```
STOPPED at file #31 after 30 GiB written        <- 23% of the 128 GiB quota
fast1/labs/t-bravo  used 14.4G  avail 49.6G  quota 64.0G
fast2/labs/t-bravo  used 14.4G  avail 49.6G  quota 64.0G
free at failure: 53280112640 / 53274738688      <- both just under minfreespace 53687091200
```

### Impact

`usable ≈ lab_quota − (branch_count × 50 GiB)`

| Fast quota (2 branches) | Actually usable |
|---|---|
| ≤ 100 GiB | **0 — the lab cannot create a single file** |
| 128 GiB | 28 GiB (23 %) |
| 256 GiB | 156 GiB (61 %) |
| 1 TiB | 924 GiB (90 %) |
| 2 TiB (shipped default) | 1.95 TiB (95 %) |

The shipped 2 TB default hides this; anyone who sets a small lab quota — as
`MULTI_DRIVE_TEST_PLAN.md` §4.2 itself instructs (64 GB) — gets a lab that is silently broken, and
the only symptom students see is a bare *"No space left on device"* on an empty home directory.

### Suggested fix
Scale it per lab instead of using a flat constant, e.g. clamp at mount time to
`min(DEFAULT_MINFREESPACE, smallest_branch_quota // 10)`. `minfreespace` is a per-mount option and
every lab already has its own mergerfs mount, so this needs no new plumbing beyond passing the
branch quota into `mount_argv`/`option_string`. Failing that, the controller should refuse (or
loudly warn on) a fast quota that leaves any branch under `minfreespace`.

**Not fixed in this worktree** — the change touches `mount`/`remount`/`attach_branch`, which
Phases 6, 7 and 9 all exercise, and destabilising those mid-run was the greater risk. Worked around
by sizing `t-bravo` at 128 GB.

## FIND-8 🟡 mergerfs 2.42 does not publish its options in `/proc/mounts`
Plan §4.4 assertion 6 says to verify options with `mount | grep mergerfs`. On 2.42 that shows only
`rw,allow_other`. The options must be read from the runtime xattr instead — all verified correct:

```
minfreespace 53687091200 · category.create mfs · moveonenospc mfs
cache.files partial · dropcacheonclose true · no use_ino
branches /mnt/lab-storage/fast1/labs/t-bravo=RW:/mnt/lab-storage/fast2/labs/t-bravo=RW
```

# EVIDENCE — Phase 5 ✅ (5.1, 5.2) and the GPU idle killer ✅

**5.1 file placement** — 30 × 1 GiB incompressible files as `sbravo1`:
* 15 on `fast1`, 15 on `fast2`, **0 duplicated on both** ✅
* every file exactly `1073741824` bytes on its branch — **never split** ✅
* alternating placement as `category.create=mfs` fills the branches ✅
* branch usage balanced: 14.4 G / 14.4 G ✅

**5.2 union reads** — all 30 visible through `/home`; md5 through the union is identical to md5 read
directly from the owning branch ✅

**B5 (small-quota split)** — 64 GiB lab quota split exactly **32.0G / 32.0G**, as predicted ✅

**GPU idle-process termination** (enabled after lab creation, as requested):
* policy pushed to the node; util ≤ 5 %, idle 1 min, grace 1 min
* `04:25:35 [WARN] gpu: warned idle GPU pid 1240545 (user=salpha1)`
* `04:26:36 [WARN] gpu: killed idle GPU pid 1240545 (user=salpha1)` — process gone, VRAM freed ✅
* **both emails delivered** to the student: *"Idle GPU process warning"* 4:25, *"Idle GPU process
  terminated"* 4:26 ✅
* GPU page: `t-alpha · 1 killed · 1 warned · 1 student` ✅
* **Safety gate ✅** — the unmanaged host `Xorg` (pid 4056, uid gdm, 2 days old, on all 4 GPUs) was
  never touched, confirming `killer.py:63` only ever acts on agent-managed lab containers.
* **Whitelist ✅** — with `salpha1` whitelisted, an identical idle 1 GiB-VRAM process survived well
  past its 2-minute warn+grace deadline with no warn or kill logged.

# EVIDENCE — Phase 6 (attach / rebalance / detach rehearsal) ✅ ALL PASS

Throwaway 200 GiB file-backed pool `fast3`. It appeared in the controller's **Attach pool**
dropdown exactly like a real disk, as the plan predicted.

**6.4 attach — all six assertions pass**

| # | Assertion | Result |
|---|---|---|
| 1 | every lab gains a third branch | `fast3/labs/{t-alpha,t-bravo}` created ✅ |
| 2 | **per-lab quota sum unchanged** | t-alpha `1099509530624` vs 1 TiB target — 2 MiB of 1 MiB-granularity rounding, **not tripled**. Donors shrank 512G→492G *before* fast3 was given 39.7G ✅ |
| 3 | branch xattr includes fast3 | `...fast1...=RW:...fast2...=RW:...fast3...=RW` ✅ |
| 4 | **no container restart** | `CreatedAt` identical, uptime ran 25→26 min. `attached_live`, no B10 fallback ✅ |
| 5 | no file moved | fast1 15 files, fast2 15, fast3 0 ✅ |
| 6 | config updated | `pools = ["fast1", "fast2", "fast3"]` ✅ |

**6.5 rebalance + deadband** — proven with real skew (120 GiB ballast written to `fast3` with
`compression=off`; a `refreservation` does *not* move `zpool list FREE`, which is what the
allocator reads):

```
fast3 FREE 199G -> 79.0G
rebalance --min-delta-gb 0  -> "rebalanced 2 of 2 lab(s)"
  t-alpha fast3 39.7G -> 24.3G  ; fast1/fast2 492G -> 500G      sum unchanged ✅
  no file moved; completes in seconds (ZFS properties only)      ✅
```

Deadband, with a genuine ~15 GB pending delta:
* `--min-delta-gb 100` → `0 of 2 lab(s)`, quotas **byte-identical** (rewrote nothing) ✅
* `--min-delta-gb 0` → `2 of 2 lab(s)`, applied ✅

**6.6 detach**
* without `--confirm` → **refused**: *"pool 'fast3' still holds data for: t-alpha, t-bravo. Drain or
  accept the loss of access explicitly"* ✅
* with `--confirm` → branch left the union live, **containers not restarted**, config back to two
  pools, and **the agent destroyed no dataset** (`fast3/labs/t-bravo` still held 64.1M) ✅
* next rebalance returned the released quota to survivors: back to exactly 512G/512G (1 TiB) and
  64G/64G (128 GiB) ✅

# BUG-5 🔴 The `zfs → mergerfs` tier promotion is broken, in two different ways

**`agent/src/lab_agent/storage/service.py` — `_move_tier_layout` / `_demote_from_mergerfs`**

This is blocker B2, the "add a second cold disk" upgrade path — the whole point of the feature.

### BUG-5a — root-first ordering: the promotion always fails when the tier has labs

Original code moved the **tier root first**, then the per-lab datasets. `zfs set mountpoint`
unmounts before it remounts, and ZFS refuses to unmount a dataset while a child is still mounted
underneath it. Observed on `geass` with two provisioned labs:

```
[ERROR] dispatch: task storage.attach_pool failed: could not promote the cold tier to mergerfs:
$ zfs set mountpoint=/mnt/lab-storage/cold1/labs cold1/labs
cannot unmount '/cold-storage': pool or dataset is busy
(the datasets already moved were restored to their original mountpoints)
```

It can therefore only ever succeed on a tier with **zero labs** — i.e. never, in production.

*Credit where due:* the rollback worked perfectly. `_demote_from_mergerfs` restored every
mountpoint and reported cleanly; no `MANUAL RECOVERY NEEDED`. B2's safety net is real.

### BUG-5b — children-first ordering silently shadows the data

The obvious fix (move children first) **does** let the promotion succeed — and then hides every
file. The root mounts *on top of* the children's new mountpoints:

```
# /proc/mounts after a children-first promotion — parent mounted LAST, over its own children
cold1/labs/t-alpha  /mnt/lab-storage/cold1/labs/t-alpha
cold1/labs/t-bravo  /mnt/lab-storage/cold1/labs/t-bravo
cold1/labs          /mnt/lab-storage/cold1/labs          <-- shadows both

# findmnt: cold1's children are SIBLINGS (not nested); cold2's, created fresh, are nested
├─/mnt/lab-storage/cold1/labs
├─/mnt/lab-storage/cold1/labs/t-alpha
├─/mnt/lab-storage/cold1/labs/t-bravo
├─/mnt/lab-storage/cold2/labs
│ ├─/mnt/lab-storage/cold2/labs/t-alpha
```

Every cold file vanished from the branch directory and from the mergerfs union, while
`zfs list` still showed the data present (`cold1/labs/t-alpha` REFER 96.2M,
`cold1/labs/t-bravo` REFER 192M). **A user would reasonably call this data loss.**

### The fix
`unmount children → move root → move children`, so each child remounts *nested under* the root's
new mount. `_demote_from_mergerfs` needs the same invariant in both halves: unmount deepest-first,
then restore **shallowest-first** (plain `reversed(moved)` satisfies neither).

Added `zfs.unmount()` (idempotent). Regression tests
`test_promotion_unmounts_labs_then_moves_the_root_then_the_labs` and
`test_rollback_restores_the_root_before_the_labs`.

### Why no test caught this
`tests/fakezfs.py` modelled `set_property("mountpoint")` as "change it, and drag every child along"
— which real ZFS only does for *inherited* mountpoints. These lab datasets have **explicit**
mountpoints, so real ZFS refuses. The fake made the broken order look correct. It now models the
busy rule, so root-first raises exactly as the kernel does.

### Recovery performed on `geass` (no data lost)
`umount /mnt/lab-storage/cold1/labs` to pop the shadowing mount → children reachable with all files
→ unmount children → mount parent → mount children → `lab-agent storage mount`. All three
pre-promotion hashes verified byte-identical afterwards:

```
e0cdd46c5f5da517ae4f1fcd1935577f  cold_a   (128 MiB)   ✅
4926fe5bcc72b33462f6c0b4fcaee992  cold_b   ( 64 MiB)   ✅
b7ee5a0af60fae20fac0fcadfb036721  cold_c   ( 96 MiB)   ✅
```

# EVIDENCE — Phase 7 (cold promotion) ✅ after the BUG-5 fix

```
[storage.cold]
backend = "mergerfs"           # promoted from "zfs"
pools = ["cold1", "cold2"]
branch_root = "/mnt/lab-storage"
```

* cold1 mountpoints moved under `/mnt/lab-storage`; cold2 branches created ✅
* **per-lab cold quota sum unchanged** — t-alpha `2199022206976` vs 2 TiB target (1 MiB rounding),
  **not doubled** ✅ — the single most important assertion of the phase
* `/cold-storage/<lab>` is now `fuse.mergerfs` (`lab-cold-t-alpha`) with both branches ✅
* containers stopped and started; `CreatedAt` unchanged (not recreated) ✅
* **FIND-6 resolved by the promotion** — `mount | grep -c 'cold1\|cold2\|lab-storage'` inside the
  lab is now **0**; the native-ZFS cold mount was the only pool-name leak ✅
* **7.5 deviation (not a defect):** new cold writes all landed on **cold1**, not cold2. Correct —
  `category.create=mfs` picks most *free* space and cold1's branch has 1.91 T free vs cold2's
  89.8 G. The plan assumed a matching 8 TB HDD-2; my stand-in is a 300 GB file-backed pool, so the
  allocator gave it proportionally less. Old files stayed put; union serves all 7 files ✅

# BUG-6 🔴 A "refused" lab destroy still destroys the container and all fast storage

**`agent/src/lab_agent/labops.py` — `destroy_lab`**

Teardown order is **container → fast tier → cold tier**, and each tier only checked *its own*
branches (`service.destroy_lab` guards per tier). With a healthy fast tier and a missing cold disk,
the guard fires at the last step — long after the destructive work is done.

Reproduced on `geass`: with `cold2` exported, removing the `t-bravo` placement produced

```
[ERROR] dispatch: task lab.destroy failed: branch(es) cold2 of 't-bravo' are unavailable;
refusing to destroy the surviving branches while data may still exist on the missing disk(s).
Restore the pool, or remove it from the tier first.
```

…while in fact it had already destroyed:

| | before | after the "refusal" |
|---|---|---|
| container `t-bravo-geass` | running | **gone** |
| `fast1/labs/t-bravo` | ~15 GiB | **destroyed** |
| `fast2/labs/t-bravo` | ~15 GiB | **destroyed** |
| `/fast/t-bravo` union | mounted | gone |
| `cold1/labs/t-bravo` | 192 M | 192 M (protected — the guard did its job) |

So the operator is told nothing was destroyed, while every student home on the node is gone and the
lab is left half-deleted. **The message actively misleads during exactly the incident it exists
for**, and the plan's own §9.2 instruction ("Attempt to remove the placement… Pass: it is refused…
Do not force it") is what triggers it.

**Fix:** hoist the guard into `service.assert_destroyable()` and pre-flight **every** tier in
`labops.destroy_lab` before removing the container or touching any dataset. Regression test
`test_destroy_lab_touches_nothing_when_only_the_COLD_tier_is_degraded` (verified failing without
the fix: `fast/labs/bio` is destroyed and the container removed).

*Note:* the pre-existing test only covered a degraded **fast** tier, where the guard happens to run
first — which is why this never surfaced.

# EVIDENCE — Phase 9 (degraded operation) ✅ ALL PASS

`cold2` exported to simulate a pulled disk.

**9.1**
1. tier reports `degraded`, `cold2: UNAVAIL (UNUSABLE)`, fast still `healthy` ✅
2. **the union came up with only `cold1` in the branch xattr** — no empty root-filesystem directory
   was silently used as a branch. This is the single most important safety property in the design ✅
3. files on `cold1` readable (hash matched) and writable; `cold2` files simply absent, not corrupt
   or zero-length ✅
4. survivors did **not** inherit the missing branch's allocation — quotas unchanged at
   `1.91T` / `46.8G` ✅

**9.2 reservation accounting** — the missing branch keeps its quota and the sum still equals the
configured total, exactly as `quota.reserved_for_missing` intends:

```
t-alpha  cold1 active  2102629761024
         cold2 missing   96393494528   sum = 2199023255552 = configured 2 TiB   ✅
t-bravo  cold1 active    50289704960
         cold2 missing   18429771776   sum =   68719476736 = configured 64 GiB  ✅
```

**9.3 recovery** — `zpool import cold2`; tier `healthy` again, both branches back in the xattr,
quotas byte-identical to before the outage, files reappeared at their original paths with matching
hashes ✅

**9.5 scrub** — all four pools scrubbed: `repaired 0B ... 0 errors`, `No known data errors` ✅
(single-disk pools detect but cannot repair — accepted in §0.2.)

## FIND-9 🟡 `rebalance` does not tell the operator that quota is reserved for a missing branch
The plan expects *"N branch(es) unavailable (cold2); X bytes of quota stay reserved for them"*.
The **behaviour** is correct (verified above), but `lab-agent storage rebalance --tier cold` printed
only `rebalanced 2 of 2 lab(s)`. The reservation is visible in `storage status --json`
(`"state": "missing"` with its `quota_bytes` retained) but never surfaced in operator-facing output,
so an admin has no signal that capacity is being held back.

## FIND-10 🟡 No `destroy-lab` CLI subcommand
`lab-agent storage` offers `status, mount, unmount, devices, add-pool, remove-pool, rebalance`.
Lab destruction is controller-only, so the plan's §9.2 CLI step has to be done through the UI.
Worth noting in the plan; not a defect.

## FIND-11 🟠 A failed destroy strands the placement in `deleting` with no UI recovery
After BUG-6's failed teardown, `t-bravo`'s placement sat in state **`deleting`** permanently:
* **Remove access** was replaced by a **disabled** `Removal queued` button — the destroy cannot be
  retried once the cold pool is restored;
* **Grant node access** reported *"No nodes available — the lab is already placed on every node"*,
  so it could not be re-provisioned either.

The only way out was **Delete lab** (which tears every placement down first). That did complete
cleanly once `cold2` was back — every `t-bravo` dataset, its container and its unions were removed
from all four pools — so the underlying teardown is sound; it is the retry path that is missing.
Recommend re-enabling the removal action whenever a placement is `deleting` but its last task failed.

# EVIDENCE — Phase 8.3 / scheduled rebalance ⚠️ PARTIAL

Settings saved and verified persisted: `rebalanceEnabled=true`, interval **1 h**, deadband **1 GB**.
The hourly ticker means a scheduled firing could not be observed inside this session, and the
controller runs on a host I have no shell access to, so `docker compose logs controller | grep -i
rebalance` could not be run. The **behaviour** the scheduler drives is fully verified by hand in
Phase 6.5 (exact re-slice applies, deadband suppresses, per-lab sums preserved), so only the
*trigger* is unverified.

# FINAL STATE (left running)

| | |
|---|---|
| Pools | `fast1` 3.62T, `fast2` 3.62T (2 × 4 TB NVMe), `cold1` 7.27T (8 TB HDD), `cold2` 298G (file-backed stand-in) |
| Fast tier | `mergerfs`, healthy, 2 pools |
| Cold tier | **`mergerfs`, healthy, 2 pools** (promoted from `zfs` in Phase 7) |
| Docker | native ZFS `fast1/docker`, 1 TiB quota, data-root `/var/lib/docker` |
| Labs | `t-alpha` (1 TB fast / 2 TB cold, 4 members) and `t-bravo` (0.5 TB / 0.5 TB, 3 members), both `active` |
| Unions | 4 — one per lab per tier |
| GPU idle killer | **enabled**, util ≤ 5 %, idle 30 min, grace 10 min, no whitelist |
| Scheduled rebalance | **enabled**, 1 h interval, 1 GB deadband |
| Scrub | all four pools clean, 0 errors |

**Left in place deliberately, remove when finished testing:**
* `cold2` is a **300 GB sparse file** at `/var/tmp/cold2/cold2.img` on the boot drive — it is *not*
  real redundancy or capacity. Replace it with the second 8 TB HDD, or detach it
  (`lab-agent storage remove-pool --tier cold --pool cold2 --confirm`) before production.
* The agent on the node is **hot-patched** with BUG-1, BUG-2, BUG-5 and BUG-6 fixes in
  `~/.local/share/uv/tools/lab-agent/...`. Originals are in `/root/evidence/*.orig`. **Re-running
  `lab-agent install` will revert every fix** until they are merged and published.
* `/root/evidence/` holds the destroyed-data manifest, pre-wipe fstab, and before/after captures.

# NOT RUN

* **Phase 5.8 reboot survival** — deferred at your request (no reboots). Worth running in a window
  when you can approve the Duo prompt, since it is the only check that `lab-storage-mounts.service`
  brings the unions up *before* Docker.
* **Phase 5.3–5.7** (hard quota ceiling, `moveonenospc`, per-student sharding, single-file > branch,
  deliberate over-commit) — blocked by **BUG-4**: with `minfreespace` at a flat 50 GiB these tests
  cannot reach the quota ceiling, because creation stops long before it. Re-run once BUG-4 is fixed.
* **Phase 10 production reset** — the labs are intentionally left running for you to inspect.

# SUMMARY — 6 bugs (5 blocking), 11 findings

| ID | Sev | What | Fixed here |
|---|---|---|---|
| BUG-1 | 🔴 | 2nd+ lab on a multi-pool tier never provisions (`zfs set mountpoint` remounts a busy dataset) | ✅ + tests |
| BUG-2 | 🔴 | No student credential can ever be verified (`SSH_ASKPASS` on a `noexec` tmpfs) | ✅ + test |
| BUG-3 | 🟠 | Storage page overstates every size by 1024× (`MiB` missing from the unit ladder) | ✅ |
| BUG-4 | 🔴 | Flat 50 GiB `minfreespace` — labs ≤ 100 GiB cannot write a single byte | ❌ documented |
| BUG-5 | 🔴 | Cold-tier promotion fails with labs present; the naive fix silently shadows all data | ✅ + tests |
| BUG-6 | 🔴 | A "refused" destroy still wipes the container and all fast storage | ✅ + test |

Agent suite **494 passed / 5 skipped**; controller **345 passed**, typecheck, lint and build clean.
