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

| Location | Storage tier | Use it for |
| --- | --- | --- |
| `~` (`/home/<username>`) | Fast | Active projects, source code, environments, frequently accessed datasets, and current checkpoints |
| `~/cold-storage` (`/cold-storage/<username>`) | Cold | Large source datasets, completed results, archives, and checkpoints that are not accessed frequently |

`~/cold-storage` is a shortcut to your private cold-storage directory. Both locations survive lab
container recreation, but persistence is not a backup guarantee. Keep another copy of irreplaceable
data in an approved backup location.

### How to use fast storage

Run active work from your home directory. Fast storage is the appropriate place for repositories,
Python or Conda environments, compiled files, caches needed by current work, and data being read or
written repeatedly by a job. For example:

```bash
mkdir -p ~/projects
cd ~/projects
```

Fast storage is limited and shared by everyone in the lab. Remove disposable caches, obsolete
environments, duplicate downloads, and failed-run output regularly. Do not keep large inactive
datasets in fast storage merely for convenience.

Useful commands for finding fast-storage usage include:

```bash
du -sh ~
du -h -d 1 ~ 2>/dev/null | sort -h
```

### How to use cold storage

Move data to cold storage when it must be retained but is no longer part of day-to-day work. Good
candidates include original datasets, completed experiment output, old checkpoints, and compressed
archives. For example:

```bash
mkdir -p ~/cold-storage/datasets ~/cold-storage/archive
mv ~/projects/completed-run ~/cold-storage/archive/
```

Cold storage has lower performance. Avoid running metadata-heavy workloads there, creating software
environments there, or repeatedly training directly against many small files there. A typical
workflow is:

1. Keep the authoritative large dataset or archived result in `~/cold-storage`.
2. Copy only the files needed for the current job into a working directory under `~`.
3. Run the job from fast storage.
4. Copy final results and checkpoints back to cold storage.
5. Verify the copied data before deleting the fast working copy.

Example:

```bash
mkdir -p ~/work/current-run
rsync -a --info=progress2 ~/cold-storage/datasets/project-a/ ~/work/current-run/input/
# Run the workload and write results under ~/work/current-run/output.
rsync -a --info=progress2 ~/work/current-run/output/ ~/cold-storage/archive/project-a-output/
du -sh ~/cold-storage/archive/project-a-output
```

`rsync` is preferable for large transfers because it can be run again to copy only missing or
changed files. Confirm the destination is complete before using `rm -rf` on the source.

## Lab storage quota

Fast and cold quotas apply to the lab as a whole, not separately to each student. Every student's
files contribute to the same lab totals. If the lab reaches a quota, writes can fail for everyone,
jobs may stop while saving output or checkpoints, and package installation may fail.

Show the lab totals and the latest per-student estimates with:

```bash
labquota
```

Show only your per-student rows with:

```bash
labquota --me
```

The lab totals are updated frequently, while the per-student breakdown comes from a periodic file
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
4. Coordinate with labmates, because the quota is shared.
5. Contact the administrator before a critical run if the remaining capacity is insufficient.

Do not assume that deleting an open file immediately releases its space. If quota usage remains
high after deletion, stop the process that still has the file open and then request a refreshed
scan.

## GPU use and process termination

GPUs are shared resources. Request a GPU only when the program will use it, release GPU memory when
work finishes, and checkpoint long-running jobs frequently. A process can reserve GPU memory while
performing no GPU computation, preventing other students from using that capacity.

### Inspect your GPU processes

Use `nvidia-smi` to see GPU utilization, memory usage, and the process IDs (PIDs) holding GPU memory:

```bash
nvidia-smi
nvidia-smi pmon -c 1
```

Before terminating anything, verify that the PID belongs to you and identify the command:

```bash
ps -o user,pid,ppid,stat,etime,cmd -p <pid>
```

Never terminate a PID that you have not identified. A PID can disappear and later be reused by a
different process, so repeat `ps` immediately before sending a signal.

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

### Automatic idle-process termination

The lab may enforce an administrator-configured idle GPU policy. It evaluates managed lab
processes that hold GPU memory and compares their GPU compute utilization with the configured idle
threshold. The idle duration, warning period, utilization threshold, and any exemptions can change;
do not assume fixed values.

Under the normal warning policy:

1. A process that continuously holds GPU memory at or below the idle threshold is tracked as idle.
2. When it exceeds the configured idle duration, the system records a warning and sends the owner a
   warning email when email delivery is configured.
3. If the process remains idle through the grace period, the system terminates it with `SIGKILL` and
   sends a termination email when email delivery is configured.
4. If GPU activity rises above the threshold before termination, idle tracking resets.

Administrators can also enable immediate termination, which skips the warning grace period. Missing
GPU utilization data is treated conservatively and is not considered proof that a process is idle.
Only processes in managed lab containers are eligible for automatic termination.

An active CPU preprocessing stage can still appear GPU-idle while holding GPU memory. Structure jobs
so they release the GPU during long CPU-only stages, or contact the administrator before running a
legitimate workload that requires an exemption. Warning emails should be acted on immediately:
checkpoint or stop the job, make sure it resumes real GPU work, or contact the administrator.

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
