# Student lab guide

Connect with the host, port, username, and password supplied by your administrator, then change your
password with `passwd`.

Your persistent paths are:

- `~` → your private persistent fast home
- `~/cold-storage` → your private cold directory at `/cold-storage/<username>`

Both locations survive container recreation. The lab's shared operating-system layer is separate
from your home and should not be used as the only copy of important data.

Use `labquota --me` to see your fast-home and cold usage. `labquota --refresh` requests a new scan
by creating `~/.labquota-refresh`.

You have `sudo` inside the lab, but the lab does not include Docker and does not expose the host
Docker socket. Codex uses its bubblewrap Linux sandbox instead:

```bash
codex --version
codex sandbox linux -- true
```

Repositories used with Codex should live in your home. Codex can create its own user, mount,
PID, and network namespaces; it cannot use that sandbox to access host files outside the lab's
mounted `/home` and `/cold-storage` roots.
