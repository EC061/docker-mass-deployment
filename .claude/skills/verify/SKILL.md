---
name: verify
description: Build/launch/drive recipe for verifying controller changes end-to-end in a real browser.
---

# Verifying the controller (Next.js admin app)

## Launch on a scratch DB

From `controller/` (custom server, hosts Next + agent WS hub on one port):

```bash
DB_PATH=<scratch>/controller.db \
SIGNUP_TOKEN="verify-signup-token-123456" \
AGENT_TOKEN="verify-agent-token-1234567" \
SESSION_SECRET="verify-session-secret-0123456789abcdef" \
PORT=8471 \
npx tsx server.ts
```

Secrets are validated at boot: SIGNUP/AGENT tokens ≥16 chars, SESSION_SECRET ≥32 chars, weak/placeholder values rejected (`src/lib/env.ts`). Migrations run automatically on first `db()` call.

## Seed data

Insert directly with `better-sqlite3` (already a dependency) against the scratch DB. Useful tables: `students (username, email, name, linux_uid, created_at)`, `labs (name, pi_email, pi_name, created_at, updated_at)`, `gpu_events (node, pid, user, lab, state, ts, cmd, idle_s)`.

## Auth

No fixture admin. Create one via `POST /signup` form fields `name/email/password/token` (token = SIGNUP_TOKEN); signup auto-logs-in and lands on `/dashboard`. `/login` uses `email/password`. All admin pages live under `src/app/(app)/`.

## Drive

Playwright works headless: `npx playwright install chromium` once, then `npm i playwright` in a scratch dir and drive `http://localhost:<PORT>`. Gotchas:

- Success/error feedback is a query param (`?msg=`, `?cleared=`, `?saved=`) rendered as a page banner — assert with `waitForURL(/msg=/)`, not toasts.
- Destructive buttons open a `ConfirmButton` dialog; click the confirm button inside `div[role=dialog]`.
- Server-action redirects re-render the page, which collapses any open `<details>` (GPU page). Re-navigate with `page.goto()` and re-expand instead of clicking through stale DOM.
- SMTP unconfigured is a fine end state for email flows: sends are recorded as "skipped (no SMTP)" in history.
