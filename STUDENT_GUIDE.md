# Student lab guide

## Connect to the lab

Use the host, port, username, and temporary password supplied by the administrator:

```bash
ssh <username>@<host> -p <port>
```

Change the temporary password immediately after your first login:

```bash
passwd
```

Your home directory is private to your account. Do not share your password or store credentials in
world-readable files.

You have `sudo` access inside the lab and it requires your own password. The lab does not include
Docker and does not expose the host Docker socket.

## Fast and cold storage

The lab provides two persistent storage locations:

| Storage tier | Relative path | Absolute path | Use it for |
| --- | --- | --- | --- |
| Fast | `~` | `/home/<username>` | Active projects, source code, environments, frequently accessed datasets, and current checkpoints |
| Cold | `~/cold-storage` | `/cold-storage/<username>` | Large source datasets, completed results, archives, and checkpoints that are not accessed frequently |

The relative paths above are what you normally type; they resolve to the absolute paths shown. For
example, `~` in your shell is exactly `/home/<username>`, and `~/cold-storage` is exactly
`/cold-storage/<username>`.

`~/cold-storage` is a shortcut to your private cold-storage directory. Both locations survive lab
container recreation, but persistence is not a backup guarantee. Keep another copy of irreplaceable
data in an approved backup location.

## Lab storage quota

Fast and cold quotas apply to your group as a whole, not separately to each student. Every group
member's files contribute to the same group totals. If the group reaches a quota, writes can fail
for everyone, jobs may stop while saving output or checkpoints, and package installation may fail.

The fast and image quotas depend on which server your group is assigned to:

| Server | Fast quota (per group) | Image quota (per group) |
| --- | --- | --- |
| asimov1 | 1 TB | 200 GB |
| asimov2 | 2 TB | 400 GB |

Cold storage is the same on both servers: **3 TB per group**.

The image quota covers the container's root filesystem — everything outside `~` and
`~/cold-storage`, such as system packages installed with `sudo apt install`. Unlike fast and cold
storage, the image does **not** survive container recreation, so keep anything you care about in
your home directory or cold storage.

Both the fast and cold quotas can be expanded temporarily on request — for example, for a large
experiment or a one-time data migration. Contact the administrator with the amount and duration you
need. The expansion is shrunk back to the standard quota once the stated need is over, so make sure
your usage is back under the standard quota by then.

### Checking usage with labquota

The best way to check storage usage is the `labquota` command. It reports the group totals against
the quotas and a per-student breakdown, without the cost of scanning directories yourself. Show the
group totals and the latest per-student estimates with:

```bash
labquota
```

Show only your per-student rows with:

```bash
labquota --me
```

The group totals are updated frequently, while the per-student breakdown comes from a periodic file
scan and can be older. The output displays when that scan last completed. Request a newer scan with:

```bash
labquota --refresh
```

A scan can take several minutes on large directory trees. If the existing result is less than one
hour old, the command reuses it. Use `labquota --refresh --force` only when a new measurement is
necessary; repeated forced scans consume storage and system I/O. For scripts that need the raw
snapshot, use `labquota --json`.

When usage is high:

1. Use `du -h -d 1 ~ 2>/dev/null | sort -h` and
   `du -h -d 1 ~/cold-storage/ 2>/dev/null | sort -h` to find large directories. The trailing slash
   on `~/cold-storage/` makes `du` inspect the linked cold directory.
2. Delete files that can be regenerated, including obsolete outputs and caches.
3. Move inactive data from fast storage to cold storage when cold capacity is available.
4. Coordinate with your group members, because the quota is shared.
5. Contact the administrator before a critical run if the remaining capacity is insufficient.

Do not assume that deleting an open file immediately releases its space. If quota usage remains
high after deletion, stop the process that still has the file open and then request a refreshed
scan.

## GPU use and process termination

### Automatic idle-process termination

GPUs are shared, so the lab automatically terminates processes that hold GPU memory (VRAM) without
doing real GPU work. The policy is:

1. A process that holds VRAM with **less than 2% GPU utilization** is tracked as idle.
2. After **more than 30 minutes** of continuous idleness, the system records a warning and emails
   the owner.
3. If the process is still idle **10 minutes after the warning**, it is killed automatically.
4. If GPU utilization rises to 2% or above at any point before the kill, idle tracking resets.

The kill is a `SIGKILL`: the process gets no chance to save a checkpoint or clean up, so act on the
warning email immediately — checkpoint or stop the job, make sure it resumes real GPU work, or
contact the administrator.

Note that an active CPU-only stage (for example, data preprocessing) can still appear GPU-idle
while holding VRAM. Structure jobs so they release the GPU during long CPU-only stages, or contact
the administrator in advance if a legitimate workload needs an exemption.

### Stop your own GPU process safely

Use the least disruptive method first:

1. If the program is attached to your terminal, save a checkpoint if supported and press `Ctrl+C`.
2. Otherwise, request a normal shutdown with `kill -TERM <pid>`.
3. Wait several seconds, then check both `ps -p <pid>` and `nvidia-smi`.
4. Use `kill -KILL <pid>` only if the process ignores the normal shutdown request. `SIGKILL` gives
   the program no opportunity to save, flush output, or clean up child processes.

```bash
kill -TERM <pid>
sleep 10
ps -p <pid>
nvidia-smi
# Last resort only:
kill -KILL <pid>
```

If a launcher owns several worker processes, stop the launcher first so it does not recreate the
workers. Inspect the process tree with `ps -f --forest -u "$USER"` or `pstree -ap <pid>` when
available. Do not use broad commands such as `pkill python` unless you have verified every matching
process.



## Administrative help

Contact [edwardcheng@uga.edu](mailto:edwardcheng@uga.edu) for:

- adding or removing students;
- login, password, SSH host, or SSH port problems;
- lab access or permission changes;
- storage quota questions or requests;
- persistent fast/cold storage or `labquota` problems;
- GPU warnings, termination questions, or exemption requests; and
- any other lab-management issue.

Include your name, UGA MyID/username, lab name, node or SSH host, and a concise description of the
problem. For errors, include the command you ran, the full error message, and the approximate time
it occurred. Do not send passwords, private keys, access tokens, or other secrets by email.
