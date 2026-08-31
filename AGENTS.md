# AGENTS.md — working in this repo as a coding agent

Orientation for automated contributors. Tool-agnostic; the parts that only apply to one assistant
live in that assistant's own file:

- **Claude Code → [CLAUDE.md](CLAUDE.md)**

Read this file first, then your assistant's file. Product documentation for humans stays where it
is: [README.md](README.md) (architecture), [HOST_PREPARATION.md](HOST_PREPARATION.md) (node setup),
[STUDENT_GUIDE.md](STUDENT_GUIDE.md), [MULTI_DRIVE_TEST_PLAN.md](MULTI_DRIVE_TEST_PLAN.md) and
[MULTI_DRIVE_TEST_RUN.md](MULTI_DRIVE_TEST_RUN.md) (the live storage test and its execution log).

## 1. What this system is

One `runc` container per lab on a fleet of GPU nodes. A central **controller** (Next.js) holds all
state; a **node agent** (Python) runs on each host and does the privileged work. Nothing polls: the
agent dials home over a WebSocket, the controller pushes `task` frames down it, and the agent
streams `result` / `log` / `event` / `telemetry` frames back up the same socket.

```
controller (Next.js + SQLite)  ──ws task──▶  lab-agent (root, systemd)  ──▶  docker / zfs / useradd
   src/app/(app)/…  admin UI    ◀─result───   src/lab_agent/…
```

Three deployables:

| Path | What it is | Ships as |
|---|---|---|
| `controller/` | Next.js 15 admin UI + custom `server.ts` that also hosts the agent WS hub on one port | `ghcr.io/ec061/lab-controller` |
| `agent/` | `lab-agent` Python CLI + systemd service, installed per node | `uv tool install` from `#subdirectory=agent` |
| `image/` | The lab container image (Ubuntu 24.04 + CUDA minimal build + bubblewrap) | `ghcr.io/ec061/custom-ssh` |

### Repo map

```
agent/src/lab_agent/
  cli.py            argparse entrypoint; every subcommand is `_cmd_*` returning an int
  installer.py      install / upgrade / start / stop; writes the systemd unit
  config.py         /etc/lab-agent/config.toml (root-only 0600 — it holds the node token)
  client.py         the WebSocket dial-home loop
  dispatcher.py     task action -> handler registry
  protocol.py       wire frames + task action constants (PROTOCOL_VERSION)
  executors/        docker.py, zfs.py, users.py, coldfs.py — the actual privileged shell-outs
  storage/          pools.py, mergerfs.py, quota.py, state.py, model.py — the multi-drive tier logic
  labops.py studentops.py containerops.py storageops.py hostprep.py   task-level operations
controller/src/
  app/(app)/        admin pages: nodes, labs, students, gpu, storage, tasks, logs, settings, …
  lib/              db.ts, nodes.ts, placements.ts, storage.ts, hub.ts (WS), auth.ts, email.ts, …
  server.ts         custom server: Next + agent WebSocket hub on the same port
image/Dockerfile    the lab image
```

### Invariants worth knowing before you edit

- **The agent runs as root and shells out.** `executors/` is where real commands are issued; keep
  privileged work there rather than scattering `subprocess` calls.
- **Wire changes are breaking.** Bump `PROTOCOL_VERSION` in `agent/src/lab_agent/protocol.py`; the
  controller refuses a mismatch. Agent and controller task-action names must be changed together
  (`protocol.py` ↔ `controller/src/lib/protocol.ts`).
- **Storage tiers are generic.** One pool = the legacy native-ZFS layout; two or more independent
  pools = one quota-bearing dataset per lab per pool, unioned by a per-lab mergerfs mount. Pools are
  independent, never vdevs of one zpool. Docker's data-root is always a native ZFS dataset, never
  mergerfs.
- **Quota arithmetic has invariants**, not just behaviour: shrink donors before growing receivers,
  never move files, never shrink below used data, and keep
  `sum(branch quotas + missing-branch reservations) <= configured quota`.
- **Destructive operations are gated.** Lab removal is blocked while a branch is missing; disk
  initialization in the UI requires an explicit destructive confirmation.
- Node names match `NODE_NAME_RE` in `controller/src/lib/nodes.ts` — lowercase `a-z0-9-`, **no
  dots**. An FQDN goes in the host alias, not the node name.

## 2. Verification

Always run both suites for the side you touched, from the repo root:

```bash
cd agent
uv run --extra dev ruff check src tests     # line length 100
uv run --extra dev pytest -q                # ~520 tests, ~2s

cd ../controller
npm run typecheck
npm run lint                                # eslint --max-warnings=0
npm test                                    # vitest
npm run build
```

CI (`.github/workflows/ci.yml`) runs the same three jobs: Agent, Controller, Lab image.

macOS can run the entire static + unit suite. It **cannot** validate AppArmor, ZFS, Docker user
namespaces, CDI, NVML, or nested Linux namespaces — those need a real Ubuntu node (§4).

Merges: this repository allows **rebase merges only**. `gh pr merge --squash` and `--merge` are
rejected; use `gh pr merge --rebase`.

## 3. The controller web UI

### Production

`https://lab.edwardcheng.net` — the live controller. Treat every action there as affecting real
students. Read-only navigation is fine; do not create, destroy, or email from it without being asked.

### Running it locally (preferred for verification)

The custom server hosts Next and the agent WS hub on one port. Secrets are validated at boot by
`src/lib/env.ts` (signup/agent tokens ≥ 16 chars, session secret ≥ 32, placeholders rejected), and
migrations run on the first `db()` call, so a scratch DB path is all the setup there is:

```bash
cd controller
DB_PATH=/tmp/scratch/controller.db \
SIGNUP_TOKEN="verify-signup-token-123456" \
AGENT_TOKEN="verify-agent-token-1234567" \
SESSION_SECRET="verify-session-secret-0123456789abcdef" \
PORT=8471 npx tsx server.ts
```

There is no fixture admin. Create one by POSTing the `/signup` form (`name`, `email`, `password`,
`token` = `SIGNUP_TOKEN`); signup auto-logs-in and lands on `/dashboard`. `/login` takes
`email`/`password`. Seed further data by writing to the scratch SQLite directly with
`better-sqlite3` (already a dependency) — useful tables: `students`, `labs`, `gpu_events`.

### Driving it in a browser

Headless Chromium works. Gotchas that will otherwise waste a cycle:

- **Feedback is a query param, not a toast.** Success/error banners come from `?msg=`, `?saved=`,
  `?cleared=`. Assert with `waitForURL(/msg=/)`.
- **Destructive buttons open a `ConfirmButton` dialog.** Click the confirm button *inside*
  `div[role=dialog]`.
- **Server-action redirects re-render the page**, collapsing any open `<details>` (the GPU page).
  Re-navigate with `goto()` and re-expand; don't click through stale DOM.
- **SMTP unconfigured is a valid end state** for email flows — sends are recorded as
  "skipped (no SMTP)" in history.

### The pages that matter

- **Nodes** → per-node **Check** (refresh docker/userns, bwrap, NVIDIA, CDI, ZFS, SMB health),
  **Repair** (reload AppArmor, refresh profiles, regenerate CDI, restart affected labs), **Reboot**.
  Each node links to a **Storage** view: devices, pool/tier membership, capacity, scrubs, mergerfs
  settings, Docker backing store, branch allocations, plus attach-pool / initialize-disk / reconcile
  / rebalance. Detaching a pool is deliberately CLI-only (`lab-agent storage remove-pool`).
- **Labs / Students** → placements, per-lab and per-student quotas, welcome email. Templates use
  `{host_alias}` when the node has an alias; `{host}` is the bare node name and will be
  unconnectable on a node reached by FQDN.
- **Tasks / Logs** → what the controller pushed and what each agent replied. First stop when a UI
  action "did nothing".
- **Settings** → SMTP, storage quota rebalance schedule (off by default, with a deadband).

## 4. The terminal window (live node access)

Nodes are Duo-gated, so there is no direct SSH from an agent session. Instead the operator keeps a
**live authenticated `Terminal.app` window** open, and a small harness drives it:

```bash
echo 'hostname; id' | /tmp/geass-harness/g.sh
```

How it works: the harness base64-encodes stdin, uses `osascript` to type it into the operator's
Terminal window (`GEASS_WID`, default `7483`), and polls that window's scrollback for a
base64-wrapped result block. Encoding both directions is what stops terminal line-wrapping from
corrupting output. Exit status of the remote command is the harness's exit status; `97` means the
window could not be reached and `98` is a timeout (`GEASS_TIMEOUT`, default 300s).

Rules for using it:

- **One self-contained script per invocation.** Nothing persists between calls — not `cd`, not
  environment variables. Use absolute paths.
- **Never run anything interactive.** No pagers, no editors, no prompts, no `sudo` password reads,
  no long `-f`/`--watch` follows. Add `2>&1`, `| cat`, `--no-pager`, and explicit `| head -n`.
- **The window belongs to the operator.** Anything you type is visible to them and shares their
  session; don't leave background jobs or change their shell state.
- **Raise `GEASS_TIMEOUT`** for genuinely slow work (`apt`, `zpool scrub`, image pulls) rather than
  letting it fail at 300s.
- **This is a real cluster.** Reads and `doctor` are free. Anything that destroys data, restarts a
  service, or touches student files needs the operator to ask for it first.
- The current window runs as an ordinary user with **passwordless sudo**. Prefix privileged commands
  with `sudo` explicitly; don't assume root.

Node facts and the current environment (drives, pools, GPU/driver versions, controller URL, known
blockers) are recorded in [MULTI_DRIVE_TEST_RUN.md](MULTI_DRIVE_TEST_RUN.md) — check there before
re-discovering them by hand.

### Agent lifecycle on a node

The agent installs **system-wide** so both root and ordinary users can run it:

| Path | What |
|---|---|
| `/usr/local/bin/lab-agent` | the CLI, on every user's PATH and on sudo's `secure_path` |
| `/opt/lab-agent/uv-tools` | the uv tool venv |
| `/usr/local/bin/uv`, `uvx` | uv itself, system-wide |
| `/etc/lab-agent/config.toml` | root-only `0600` — it holds the node's controller token |

```bash
sudo lab-agent upgrade     # reinstall newest from git + restart the service
sudo lab-agent doctor      # full health check
sudo systemctl status lab-agent --no-pager
journalctl -u lab-agent -n 100 --no-pager
```

`doctor` needs a *running lab with a provisioned student* for its final checks — it executes the
real bwrap and `nvcc` smoke tests as that ordinary user. On a node with no labs deployed,
`lab_smoke_unavailable` is doctor reporting accurately, not a bug.

## 5. Conventions

- **Comments explain why, not what.** The existing code is sparse and load-bearing; match that
  density. Don't narrate a line that already reads clearly.
- **Python:** `from __future__ import annotations`, `pathlib`, dataclasses, 100-col lines. CLI
  commands print to stdout and return an int; errors print `f"<verb> failed: {exc}"` to stderr and
  return `1`. Never let a traceback reach an operator — `cli.main` catches `PermissionError` and
  `KeyboardInterrupt` as a backstop, but handle the expected failure where it happens.
- **TypeScript:** server components and server actions by default; `lib/` holds all data access.
  Lint runs with `--max-warnings=0`, so an unused import fails CI.
- **Tests live beside the behaviour they describe** (`agent/tests/test_*.py`,
  `controller/src/**/*.test.ts`) and get named for the guarantee, not the function. Prefer
  `monkeypatch` over mocks that assert call shapes.
- **Never touch the operator's uncommitted files.** `MULTI_DRIVE_TEST_RUN.md` and scratch YAML in
  the repo root are frequently mid-edit; leave them alone unless asked.
- **Branch and PR.** Don't commit to `main`. Branch, run both suites, open a PR, merge with
  `--rebase`.
