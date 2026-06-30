# Student lab guide

Connect with the host, port, username, and password supplied by your administrator, then change your
password with `passwd`.

Your persistent paths are:

- `~/scratch` → your private fast directory at `/fast/<username>`
- `~/cold-storage` → your private cold directory at `/cold/<username>`

Both directories survive container recreation. Other files in your home are part of the container
root filesystem and should not be treated as the only copy of important data.

Use `labquota --me` to see your fast, cold, and container-home usage. `labquota --refresh` requests
a new scan by creating `/fast/<username>/.labquota-refresh`.

You have `sudo` inside the lab, but the lab does not include Docker and does not expose the host
Docker socket. Codex uses its bubblewrap Linux sandbox instead:

```bash
codex --version
codex sandbox linux -- true
```

Repositories used with Codex should live under `~/scratch`. Codex can create its own user, mount,
PID, and network namespaces; it cannot use that sandbox to access host files outside the lab's
mounted `/fast` and `/cold` roots.
