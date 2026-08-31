# CLAUDE.md — Claude Code in this repo

**Start with [AGENTS.md](AGENTS.md).** It covers what the system is, the repo map, the invariants,
the verification commands, the controller web UI, and how to drive the live node's terminal window.
Everything below is Claude-specific: which tools to reach for, and how they map onto the workflows
described there.

## Tools

### Bash — the live node

The `/tmp/geass-harness/g.sh` harness (AGENTS.md §4) is invoked through Bash. It is slow (it polls a
GUI window every 2s), so batch aggressively — one heredoc script that gathers everything you need
beats six round trips:

```bash
cat <<'EOF' | /tmp/geass-harness/g.sh
set -x
lab-agent --version
sudo systemctl is-active lab-agent
sudo zpool list
docker ps -a --format '{{.Names}}\t{{.Status}}'
EOF
```

Anything long-running (an `apt` install, `zpool scrub`, an image pull) should get a raised
`GEASS_TIMEOUT` and a Bash `timeout` above the harness default, not a retry loop. Prefer
`run_in_background: true` over blocking the session on a 10-minute install.

### Playwright MCP — the controller UI

Use `browser_navigate` / `browser_snapshot` / `browser_click` against a **locally launched**
controller (AGENTS.md §3) for verification work. `browser_snapshot` beats `browser_take_screenshot`
for reading state — it's the accessibility tree, not pixels. Screenshots are for showing the
operator something visual.

Against the production controller (`lab.edwardcheng.net`), stay read-only unless the operator asked
for a specific change. It is a live system with real students.

### Subagents

Delegate broad fan-out reads — "where is quota sharding implemented across agent and controller",
"find every call site of this task action" — to `Explore`. Don't delegate the edit itself; the
invariants in AGENTS.md §1 are easy to violate without the surrounding context.

### Skills

`/verify` (`.claude/skills/verify/SKILL.md`) is the canonical build/launch/drive recipe for
controller changes: scratch DB, boot env vars, signup-to-create-an-admin, and the browser gotchas.
Invoke it rather than reconstructing the launch command.

## Working style here

- **Run the suites yourself before saying it works.** `uv run --extra dev pytest -q` in `agent/` is
  under two seconds; there is no excuse for reporting untested changes. Quote real output.
- **Use a git worktree for PR work.** The primary checkout is usually parked on a long-running
  branch with the operator's uncommitted edits (`MULTI_DRIVE_TEST_RUN.md`, scratch YAML). Branch off
  `origin/main` in `/tmp/<name>` instead of stashing their work.
- **`gh pr merge --rebase`.** Squash and merge commits are both rejected by this repository.
- **Read before you diagnose.** Most "it's broken" reports here are environment, not code — a
  missing PATH entry, a 0600 config, a node with no labs deployed. Check the box with the harness
  before changing a line.
- **Report accurately.** If `doctor` says `lab_smoke_unavailable` because nothing is deployed, say
  that; don't "fix" a correct message.

## Node toolchain on this Mac

Homebrew's `node@24` is keg-only, so `node`/`npm`/`npx` are absent from the PATH a Bash call starts
with. Export it at the top of every call that runs JS tooling:

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
```

A fresh worktree also has no `controller/node_modules`. `npm ci` installs, but npm 11 gates native
install scripts, so `better-sqlite3` stays unbuilt — and `npm run test`/`typecheck` then fail in a
way that looks like a code problem:

```bash
npm ci
npm approve-scripts better-sqlite3 esbuild fsevents unrs-resolver
git checkout -- package.json   # approve-scripts writes an allowScripts block; don't commit it
```
