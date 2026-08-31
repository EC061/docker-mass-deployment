# Multi-Drive Clean-Redeploy Retest — `geass`

Resumable execution log for the clean teardown and redeployment requested on 2026-08-30.
Update every checkbox and evidence section as work proceeds.

## Fixed scope and safety boundaries

- [x] Use only the existing Duo-authenticated Terminal window for `geass` commands.
- [x] Preserve the separate boot disk (`nvme1n1`) and ordinary host accounts.
- [x] Real data disks `nvme2n1`, `nvme0n1`, and `sda` are disposable.
- [x] Remove everything created by the prior Claude run, including live test labs and synthetic pools.
- [x] Capture stable device IDs immediately before destructive work.
- [x] Preserve `/root/evidence` and add this run's evidence unless it conflicts with a clean install.

## 0. Pre-teardown baseline

- [x] Record commit/image/version under test.
- [x] Record `lsblk`, mounts, `fstab`, ZFS pools/datasets, Docker root and containers.
- [x] Record lab-agent package/config/service/storage status and health.
- [x] Record controller nodes, labs, placements, settings, GPU policy, and scheduler state.
- [x] Verify the three destructive device serials and separately identify the boot device.
- [x] Capture hashes or manifests needed to prove that only disposable test data is removed.

## 1. Clean teardown

- [x] Remove controller placements and disposable labs cleanly.
- [x] Verify `lab.destroy` completes and no controller task is stranded.
- [x] Stop/disable lab-agent and Docker.
- [x] Remove all managed and legacy Docker containers, images, volumes, and Docker data-root.
- [x] Export/destroy synthetic `cold2`; delete its sparse backing file.
- [x] Unmount all fast/cold mergerfs unions and remove test-only mount state.
- [x] Destroy `fast1`, `fast2`, and `cold1` after rechecking their backing devices.
- [x] Wipe filesystem/ZFS signatures only on the three confirmed data disks.
- [x] Remove the prior hot-patched agent install, config, service state, and test artifacts.
- [x] Confirm boot disk, root filesystem, GPU driver, network, and host accounts remain intact.

## 2. Clean bootstrap

- [x] Install merged agent code containing PR #131 fixes; record exact commit/artifact.
- [x] Verify matching OpenZFS userland/kernel and mergerfs >= 2.35.
- [x] Run initial `host-prepare` and capture all changes.
- [x] Create `fast1`, `fast2`, and `cold1` from stable by-id paths.
- [x] Configure fast mergerfs tier, initial cold ZFS tier, and native-ZFS Docker data-root.
- [x] Run second `host-prepare`; verify Docker uses ZFS and survives restart.
- [x] Verify zero-lab storage convergence and no orphan mountpoints.

## 3. Controller registration

- [x] Provision/register node `geass` and set alias `geass.cs.uga.edu`.
- [x] Verify WSS connection, forwarded host behavior, heartbeat, four GPUs, and storage inventory.
- [x] Verify correct GiB/TiB UI formatting and controller image behavior from PR #131.
- [x] Run node check/doctor and classify every warning or critical result.

## Findings during this retest

### RETEST-FIND-1 — zero-byte virtual disk is offered for destructive initialization

After a full `storage.status` refresh, both Fast and Cold “Add a new drive” selectors offer
`Virtual HDisk0 · 0 B · /dev/disk/by-id/usb-AMI_Virtual_HDisk0_AAAABBBBCCCC3-0:0`. A zero-byte
device cannot back a zpool and should be filtered from `storage devices` and/or the controller
picker before the destructive action is offered. It was not selected.

### RETEST-FIND-2 — welcome email advertises a nonexistent `~/scratch` path

The fresh welcome email tells every member that `~/scratch` is the fast working-storage path.
An actual password SSH login as `sbravo1` showed that the 512 GiB mergerfs tier is mounted at
`/home`, the member home is writable there, and `~/cold-storage` correctly links to the member's
cold directory, but `~/scratch` does not exist. Either provision the advertised symlink or update
the email template to describe the home directory as fast storage. This does not block storage use,
but it is a fresh-install user-facing contract mismatch.

### RETEST-FIND-3 — BUG-4 reproduces on the clean PR #131 deployment

After changing `t-bravo` to 64 GiB fast / 64 GiB cold, the fast branch quotas converged to
`34,357,641,216 + 34,360,786,944 = 68,718,428,160` bytes (64 GiB minus the normal 1 MiB split
tolerance). The live mergerfs mount still reported `minfreespace=53,687,091,200`. A one-byte file
create as `sbravo1` immediately failed with `No space left on device`, despite essentially zero
usage. This is the same flat-50-GiB-per-branch defect, now reproduced after complete disk wipe and
bootstrap from merge commit `de061c084896f06966e6717e639a3fcc0e48cd55`.

### RETEST-FIND-5 — `labquota --refresh --force` cannot run when home is full

At the proven 64 GiB fast quota ceiling, `labquota --refresh --force` failed before contacting the
agent with `No space left on device: '/home/sbravo1/.labquota-refresh'`. After deleting one 1 GiB
test file, the same command completed, scanned all three members, and updated `sbravo1` to 63.0 GiB
both in `labquota --me` and the controller's per-student Stats table. The refresh request channel
should live in the already-mounted `/run/labquota` control area (or another non-home path) so the
diagnostic remains usable precisely when a quota is exhausted.

### RETEST-FIND-6 — aggregate fast quotas can exceed physical capacity without warning

The controller rejected an individual 8 TiB fast quota because it exceeded the node's displayed
7.3 TiB capacity, but accepted `t-alpha = 7.25 TiB` while `t-bravo = 64 GiB` remained active. The
agent assigned `t-alpha` branch quotas totaling the full `7,971,459,301,376`-byte tier capacity and
left Bravo's additional `68,718,428,160` bytes in place. `storage status` reported both labs as
`over_committed: false`, and `storage rebalance --min-delta-gb 0` said both were already balanced.
Thus the sum of granted branch quotas exceeded physical tier capacity with no unallocated-byte or
warning signal, contrary to the test-plan invariant. Alpha was immediately restored to 1 TiB.

### RETEST-FIND-7 — per-student cold datasets are invisible in the initial container mount namespace

With Alpha's per-student cold quotas enabled, the agent created and mounted
`cold1/labs/t-alpha/{pialpha,salpha1,salpha2,salpha3}` only after the lab container's `/cold-storage`
bind mount already existed. The host child dataset for `salpha1` was owned by UID 10024 with mode
0700, but the same path inside the container was the root-owned 0755 directory underneath that
later mount and the student could not write it. The container bind is `rprivate`, so the later ZFS
child mounts do not propagate into the running container. Restarting or changing the provisioning
order is required whenever child datasets are introduced after the bind namespace is created.

### RETEST-FIND-8 — cold-tier promotion strands existing per-student datasets at old mountpoints

Promoting cold from one ZFS pool to a `cold1:cold2` mergerfs tier restarted both containers and
preserved the lab-level quotas, but all four Alpha child datasets retained mountpoints below
`/cold-storage/t-alpha/<user>` and reported `mounted=no`. Their existing files disappeared from the
new union, and a subsequent `lab-agent storage mount` still reported two degraded labs without
repairing them. Manually moving only those four dataset mountpoints to
`/mnt/lab-storage/cold1/labs/t-alpha/<user>` made the original hash reappear and restored student
writes. The promotion must migrate descendant mountpoints, not only the lab root dataset.

### RETEST-FIND-9 — the long-running agent keeps a detached pool in its in-memory config

After the guarded and confirmed `fast3` detach, `/etc/lab-agent/config.toml` correctly returned to
`pools = ["fast1", "fast2"]`; SQLite state marks `fast3` removed and a fresh standalone
`lab-agent storage status` process reports the fast tier healthy. The already-running agent service,
however, continues to include `fast3`: controller-originated `storage.status` and `node.check` tasks
list it as `UNAVAIL`, mark fast degraded, and add a second critical health issue. This isolates the
phantom to stale in-memory agent configuration, not just controller rendering. A controller task
that changes the pool list must update/reload the service's active config (or restart cleanly) once
the mutation completes.

### RETEST-FIND-10 — degraded rebalance omits the promised reservation warning

With `cold2` exported, live status correctly marked its saved branch allocations as `missing` and
kept their quotas reserved in state. Nevertheless
`lab-agent storage rebalance --tier cold --min-delta-gb 0` printed only
`rebalanced 2 of 2 lab(s)` rather than naming the unavailable branch or reserved bytes. It also
rewrote each surviving `cold1` quota upward by exactly 1 MiB (rounding) instead of leaving it byte
for byte unchanged. No missing allocation was transferred and no data was lost, but the operator
warning required by the degraded-mode contract is absent.

### RETEST-FIND-11 — no hourly scheduled rebalance was observed

The controller remained connected to `geass` for more than five hours with scheduled rebalance
enabled at a 1-hour interval and 1 GiB deadband. The task/log history contains no tasks at all in
the intervening 1–4 hour window, and enumerating every task from the five-hour deployment burst
found no `storage.rebalance`. A manual Storage-page rebalance immediately produced a successful
task with the correct `{tier: "fast", min_delta_bytes: 0}` parameters, so dispatch and agent-side
rebalance work. The hourly maintenance path therefore has no end-to-end evidence of firing in this
deployment and should be treated as failed pending controller-ticker investigation.

## 4. Pseudo-lab deployment

- [x] Create two disposable labs so second-lab provisioning is exercised.
- [x] Use `ningxicheng111@gmail.com` as PI and `ningxicheng112@gmail.com` plus aliases as students.
- [x] Configure finite lab fast/cold/rootfs quotas and per-student quotas.
- [x] Verify every member reaches active, welcome emails arrive, alias is correct, and credentials work.
- [x] Verify `labquota`, home/cold paths, sudo policy, ports, and container contract. (The
  security/mount contract, student password SSH, non-passwordless sudo behavior, four GPUs, and
  quota reporting pass; the advertised `~/scratch` path fails as a finding.)
- [x] Exercise failed-member retry and failed-removal retry without disturbing active members.
  (`sbravo3` first failed at the clean deployment's reproduced 50 GiB `minfreespace` defect while
  the existing members stayed active. After a runtime-only 1 MiB workaround, Retry provisioned the
  member, both persistent paths were writable, and the credential email arrived. The original
  50 GiB value was restored. For removal, exporting `cold2` put the placement in `deleting` with a
  precise missing-branch error and Retry removal control; restoring the pool preserved all hashes
  and quotas, and Retry then removed the placement cleanly.)

## 5. Storage and quota tests

- [x] Verify multi-pool branch split sums to each configured quota, not quota per branch.
- [x] Verify one file resides on exactly one branch and union reads match direct branch hashes.
- [x] Reproduce BUG-4 against the clean deployed code and record exact behavior.
- [x] With a documented runtime-only 1 MiB `minfreespace` override, verify small labs can write and
  reach their true quota ceiling. (No deployed code was hot-patched.)
- [x] Test hard lab quota, per-student quota sharding, `moveonenospc`, oversized single-file
  failure, and deliberate overcommit. (The first four pass; overcommit warning/accounting fails as
  RETEST-FIND-6.)
- [x] Verify quotas never shrink below used data and rounding stays within documented tolerance.
  (With 9,671,581,696 bytes physically committed, a live request for 4 GiB failed explicitly,
  stated that branches were pinned at usage and no data was removed, and left both hashes/data and
  original quotas intact. Restoring 1 TiB applied with the normal <=1 MiB split tolerance.)
- [x] Verify no unintended pool paths/data are exposed inside containers. (Only `/home`, the
  lab-specific `/cold-storage`, and read-only `/run/labquota` are mounted; neither container can
  see `/mnt/lab-storage`, pool names, or the other lab's logical paths.)

## 6. Pool lifecycle and failure tests

- [x] Create temporary file-backed `fast3`; attach live and verify no restart or quota multiplication.
- [x] Test rebalance with zero deadband and suppress it with a large deadband.
- [x] Test guarded detach, confirmed detach, retained dataset behavior, and cleanup.
- [x] Create temporary file-backed `cold2`; promote cold ZFS to mergerfs with live labs.
- [x] Verify data hashes, mount ordering, quota neutrality, and required container restart. (The
  lab-root behavior passes; existing per-student descendants fail until manually recovered as
  RETEST-FIND-8.)
- [x] Simulate a missing pool; verify degraded union, reserved quota, destroy preflight, and survivor behavior.
  (Degraded health, cold1-only branch xattrs, survivor read/write, hidden cold2 files, and reserved
  state all pass. The controller removal preflight also passed: it refused to destroy surviving
  `t-bravo` branches while `cold2` was absent, left the placement retryable, and completed only
  after `cold2` was restored with hashes and quotas unchanged.)
- [x] Restore the pool; verify files, quotas, mounts, and health recover exactly. (Two files stored
  only on cold2 disappeared while exported and returned with identical SHA-256 hashes; complete
  loss of cold1+cold2 left both logical paths unmounted, preventing root-filesystem fall-through.)
- [x] Scrub every physical pool and record results. (`fast1`, `fast2`, and `cold1`, plus synthetic
  `cold2`, all completed with 0 B repaired, 0 checksum/read/write errors, and no known data errors.)

## 7. GPU, agent, and scheduler tests

- [x] Enable idle GPU termination after lab creation.
- [x] Test warning then kill with short temporary thresholds and verify both emails. (Fresh managed
  PID warned after 1 minute and was killed after the 1-minute grace; both new student Gmail
  messages arrived and the GPU page attributed the event to `t-alpha`/`salpha1`.)
- [x] Test whitelist exemption and unmanaged-host-process safety. (A second `salpha1` CUDA process
  survived 2m32s with no warn/kill while whitelisted; a simultaneous unassigned host CUDA process
  also survived throughout. Both were explicitly stopped after the test.)
- [x] Restore production idle/grace thresholds and no unintended whitelist. (Enabled, 5% util,
  30-minute idle, 10-minute grace, immediate off, both whitelist fields empty.)
- [x] Test lab-agent status, doctor, repair reporting, restart, and reconnect behavior. (Safe repair
  refreshed CDI and restarted both lab containers; service restart changed only the agent PID,
  preserved container IDs/start times and
  data hashes, reconnected in under a second, and cleared stale in-memory `fast3`.)
- [x] Test scheduled rebalance trigger plus manual rebalance semantics. (Manual UI task passes and
  carries `min_delta_bytes: 0`; no hourly scheduled task was observed — RETEST-FIND-11.)
- [ ] Test reboot survival only if a post-reboot Duo reconnection is available.

## 8. Findings and final state

- [x] Record every anomaly with command/UI evidence, severity, reproduction, and suspected component.
- [x] Add regression tests for any code fix that is in scope. (No source fix was made during this
  deployment retest; the clean merged code was tested unchanged, so no new regression test applies.)
- [x] Remove all synthetic pools, ballast, quota-test files, and disposable labs.
- [x] Leave physical `fast1`/`fast2`/`cold1`, native-ZFS Docker, agent, alias, and production GPU policy healthy.
- [x] Confirm no hot patch, fake capacity, orphan mountpoint, stale controller task, or test credential remains.
- [x] Publish a final pass/fail/deferred table and exact final inventory.

## 9. Final pass/fail/deferred matrix

| Area | Result | Final evidence / qualification |
|---|---|---|
| Full teardown and clean bootstrap | PASS | Prior containers, images, pools, packages, state, and signatures were removed from the three authorized data disks; the boot disk was preserved. The agent was installed from merged PR #131 commit `de061c084896f06966e6717e639a3fcc0e48cd55`, with no deployed hot patch. |
| Persistent Duo SSH workflow | PASS | One Duo-approved Terminal SSH session and keepalive/control-master workflow survived the run; every `geass` command used that same Terminal window. |
| Controller registration and alias | PASS | `geass` is online with per-node auth, four GPUs, and alias `geass.cs.uga.edu`; heartbeat was one second old in the final UI check. |
| Pseudo-lab provisioning, email, and SSH | PASS with findings | Both labs and all members provisioned; PI/student Gmail deliveries and password SSH worked. `~/scratch` is missing (FIND-2). |
| Member failure and retry | PASS | Existing members remained active; `sbravo3` reached active after Retry and received a fresh credential email. The initial failure was another direct manifestation of FIND-3. |
| Multi-drive quota and placement | PASS with findings | Split quota sums, one-branch file placement, hard ceilings, sharding, `moveonenospc`, oversized-file refusal, no-shrink-below-used, and container path isolation passed. Aggregate overcommit reporting failed (FIND-6); refresh-at-full failed (FIND-5). |
| Fast pool lifecycle | PASS with finding | Synthetic `fast3` attach, rebalance/deadband, guarded detach, confirmed detach, and cleanup passed. A service restart was required to clear stale in-memory config (FIND-9). |
| Cold promotion and recovery | PASS with finding | `cold2` promotion kept aggregate quotas neutral and lab-root data intact; descendant per-student mounts required manual recovery (FIND-8). Export/reimport and total-loss fall-through protection passed. |
| Missing-pool destroy guard and retry | PASS | With `cold2` exported, placement removal failed safely before destroying any surviving branch and exposed Retry removal. After recovery, hashes and quotas matched exactly and retry teardown succeeded. |
| ZFS scrubs | PASS | `fast1`, `fast2`, `cold1`, and synthetic `cold2` completed with 0 B repaired and no read/write/checksum errors. |
| GPU idle termination | PASS | Fresh managed work warned and was killed after the temporary test thresholds; email delivery, whitelist exemption, and unmanaged-host-process safety passed. Production policy was restored. |
| Agent check/repair/restart | PASS with expected final critical | Service repair/restart/reconnect and state reload passed. With no test labs left, final doctor reports only `lab_smoke_unavailable` because there is no running provisioned student container in which to repeat the CUDA smoke check. |
| Manual quota rebalance | PASS | Controller task carried `min_delta_bytes: 0` and completed successfully. |
| Scheduled hourly rebalance | FAIL | No scheduled task appeared over more than five hours despite enabled 1-hour/1-GiB settings (FIND-11). |
| Reboot survival | DEFERRED | Not run because reboot would terminate the Duo-authenticated persistent session and require a fresh interactive approval. |
| Local regression suites | PASS | Agent lint plus 494 tests passed (5 skipped); controller typecheck/lint/build plus 351 tests passed. |
| Final teardown | PASS | Only the four real lab records remain; neither has been modified or placed on `geass`. All pseudo records, accounts, containers, datasets, mounts, quota caches, maintenance entries, and synthetic backing files are absent. |

## 10. Exact final inventory

Captured at `2026-08-30T21:29:05-04:00` in
`/root/evidence/retest-44-final-clean-inventory.txt` on `geass`.

- Services: `lab-agent.service` and `docker.service` are enabled and active; controller heartbeat
  and task dispatch are live.
- Pools: `fast1` ONLINE 3.62 TiB, `fast2` ONLINE 3.62 TiB, `cold1` ONLINE 7.27 TiB; `zpool status -x`
  reports all pools healthy. There is no `fast3` or `cold2` pool or backing image.
- Tier config: fast is healthy mergerfs over `fast1` and `fast2`; cold remains healthy mergerfs over
  only `cold1`. Remaining on mergerfs after returning to one pool is the known non-demotion behavior
  documented as plan blocker B8, not stale pool state.
- Docker: native `zfs` storage driver at `/var/lib/docker`, backed by `fast1/docker`, with the 1 TiB
  quota intact. No lab containers remain.
- Lab storage: only the empty roots `fast1/labs`, `fast2/labs`, and `cold1/labs` remain. There are no
  `t-alpha`/`t-bravo` datasets, union mounts, branch directories, Unix accounts, labquota caches, or
  maintenance records.
- GPUs: four devices detected, no compute processes running. Idle killer is enabled at 5% utility,
  30-minute warning threshold, 10-minute grace, immediate-kill off, and empty user/lab whitelists.
- Controller labs: `Dou_Fei_Lab` (5 students), `Geng_Yuan_Lab` (7), `Jin_Lu_Lab` (4), and
  `Wei_Niu_Lab` (7), all with no node placement. `t-alpha`, `t-bravo`, and all eight pseudo usernames
  return zero matches.
- Controller storage inventory shows only `fast1`, `fast2`, and `cold1`, all ONLINE, and native-ZFS
  Docker. Alias remains `geass.cs.uga.edu`.
- Controller production settings remain: default quotas 2 TiB fast / 3 TiB cold; scheduled scrub
  every 30 days at 03:00 America/New_York; scheduled rebalance enabled every hour with 1 GiB
  deadband. The latter should be disabled or fixed before relying on it because FIND-11 failed.
- The test GPU event rows and controller task/log history were retained as audit evidence; they do
  not contain active lab access or server accounts. `/root/evidence` was intentionally retained.

## 11. Findings triage

| Finding | Severity | Suspected component | Disposition |
|---|---|---|---|
| FIND-1 zero-byte disk offered | Medium | agent device discovery / controller picker | Open; never selected. |
| FIND-2 nonexistent `~/scratch` advertised | Medium | welcome template / provisioner | Open. |
| FIND-3 50 GiB minimum breaks small labs | High | mergerfs tier policy | Open; directly affected provisioning and required runtime-only test workarounds. |
| FIND-5 refresh channel fails at full home | Medium | `labquota` refresh IPC | Open. |
| FIND-6 aggregate quota overcommit invisible | High | quota allocator/status validation | Open. |
| FIND-7 late child mounts invisible | High | provisioning order / mount propagation | Open. |
| FIND-8 promotion strands child datasets | Critical | storage promotion mountpoint migration | Open; manual recovery was needed in the disposable lab. |
| FIND-9 service retains detached pool | High | agent runtime config reload | Open; service restart clears it. |
| FIND-10 degraded rebalance warning absent | Medium | rebalance reporting/rounding | Open; no missing quota was reassigned. |
| FIND-11 hourly scheduler did not fire | High | controller maintenance ticker | Open; manual path works. |

## 12. Evidence index

- Baseline through bootstrap: `retest-00-baseline.txt` through
  `retest-04-pool-create-and-second-prep.txt`.
- Provisioning, BUG-4, quotas, sharding, and placement: `retest-05-phase4-contract.txt` through
  `retest-15-overcommit.txt`, plus `retest-38-quota-below-used.txt` and
  `retest-39-member-retry.txt`.
- Pool lifecycle and failures: `retest-16-fast3-before.txt` through
  `retest-31-scrubs.txt`, plus `retest-40-removal-preflight.txt` and
  `retest-41-removal-recovery.txt`.
- Container/GPU/agent: `retest-32-container-path-exposure.txt` through
  `retest-37-agent-restart-reconnect.txt`.
- Cleanup and final inventory: `retest-42-test-lab-cleanup.txt`,
  `retest-43-final-server-inventory.txt`, and authoritative clean snapshot
  `retest-44-final-clean-inventory.txt`.
