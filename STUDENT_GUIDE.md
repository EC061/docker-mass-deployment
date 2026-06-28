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

## Running Docker (only if you really need it)

> **Try not to use Docker here.** Your lab container already gives you `sudo`, Python, and direct
> access to the GPUs — for almost everything (installing packages, running training, notebooks) you do
> **not** need a nested container. Reach for Docker **only** when a project genuinely requires it, e.g.
> it ships a `Dockerfile`/`docker-compose.yml` you must run as-is. Nested containers are slower to
> start and share one daemon with your whole lab.

When you do need it, Docker is already installed and running — no setup. You're in the `docker` group,
so just run `docker`:

```bash
docker run --rm hello-world
```

All images and containers are stored on the lab's **shared fast tier** (`/labdata/fast`), so they
count against your lab's storage quota and the image cache is shared with your labmates. Clean up
images you no longer need with `docker image prune`.

### Passing your GPU into a container

Add `--gpus all` (verify with `nvidia-smi` inside the container):

```bash
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

### Passing your scratch and cold storage into a container

Bind-mount your own folders so work survives the container and lands on the right storage tier. Use
the real paths (your `~/scratch` and `~/cold-storage` are symlinks):

```bash
docker run --rm -it --gpus all \
  -v "$(readlink -f ~/scratch):/scratch" \
  -v "$(readlink -f ~/cold-storage):/cold-storage" \
  -w /scratch \
  nvidia/cuda:12.4.0-base-ubuntu22.04 bash
```

Anything written to `/scratch` or `/cold-storage` inside the container appears in your `~/scratch` /
`~/cold-storage` and persists. **Don't** store data only inside the container's own filesystem — it's
on the shared fast tier and is lost when the container is removed.

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
