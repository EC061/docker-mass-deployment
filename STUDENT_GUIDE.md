# Student Guide

Welcome to your lab environment. You access it over SSH and get personal fast + slow storage.

## Connecting

You'll receive an email with your username, a temporary password, and a command like:

```bash
ssh your_username@HOST -p PORT
```

- `HOST` is your lab server (or the address your admin gave you).
- `PORT` is the port assigned to your lab (not the usual 22).

Change your password after first login:

```bash
passwd
```

You can also connect with **VS Code Remote - SSH** using the same host, port, and username.

## Your storage

Inside the container your home directory has two special folders:

| Folder | Backed by | Use it for |
|---|---|---|
| `~/scratch` | **fast** NVMe storage | active datasets, checkpoints, anything you're working on now |
| `~/cold-storage` | **slow** bulk storage | results and data you want to keep but rarely touch |

Shared lab data your instructor provides is under `/labdata/fast` and `/labdata/slow`.

Storage is **quota-limited per lab**. If the lab gets close to its limit, your PI is notified with a
per-student breakdown — so clean up files you no longer need. Old, untouched files in `~/scratch` and
`~/cold-storage` are periodically reported to your admins as cleanup candidates.

> **Install your environments under `~/scratch`.** Anything you install into your home directory
> (a `venv`/conda env, downloaded software) lives inside the container and is **lost if the container
> is ever rebuilt**. Files in `~/scratch` and `~/cold-storage` are on persistent storage and survive.
> For example: `python3 -m venv ~/scratch/envs/myproject`.

### Checking your usage

Run `labquota` to see a whole-lab breakdown — your usage **and** your labmates' — across scratch,
cold storage, and software you've installed in the container:

```bash
labquota              # whole-lab table
labquota --me         # just your own usage
labquota --refresh    # recompute installed-software sizes (and watch the progress)
```

`scratch`/`cold` numbers are always current. The **installed** column (software in your container
home) is measured periodically; `labquota --refresh` asks the server for a fresh measurement if the
last one is over an hour old.

## GPUs

All of the server's GPUs are available to your lab. To keep them fair for everyone, there is an
**idle-process killer**:

- If a process is holding GPU memory but **not actually using the GPU** for a while, you'll get a
  warning email.
- If it stays idle past the grace period, it will be **terminated** and you'll get a notice.

To avoid losing work: don't leave dead notebooks/REPLs holding the GPU, checkpoint long runs, and keep
the GPU active while you need it. If you have a legitimate long idle job, ask an admin to whitelist it.

## Tips

- Check your GPU usage with `nvidia-smi`.
- Put large data in `~/scratch` (fast) while training; move finished results to `~/cold-storage`.
- Files you create default to `umask 027` — readable/writable by you, not by other students. To
  share a file with a teammate, grant access explicitly (e.g. `chmod g+rw <file>` within a shared
  group folder) rather than making everything world-writable.

If something isn't working, contact your lab admin.
