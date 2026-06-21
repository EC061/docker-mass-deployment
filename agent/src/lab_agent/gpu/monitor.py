"""Live GPU process listing and PID -> container -> student-user resolution.

`list_gpu_processes()` powers the telemetry snapshot (and phase 4's idle killer). It merges:
  - `nvidia-smi --query-compute-apps=pid,used_gpu_memory` (VRAM held per PID), and
  - `nvidia-smi pmon -c 1` (per-PID SM utilization), the signal for "idle but holding VRAM".

Each process is resolved to its Docker container (via the host PID's cgroup) and to the student's
in-container username (via `getent passwd <uid>` inside that container), so the controller can map a
process to the right lab/student and email them.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass

from ..executors.base import run

_DOCKER_CGROUP = re.compile(r"docker[-/]([0-9a-f]{12,64})")


@dataclass
class GpuProcess:
    pid: int
    vram_bytes: int
    util: float | None  # SM utilization %, None if unknown
    container: str | None
    user: str | None
    start_time: int | None = None  # /proc/<pid>/stat field 22; identifies the PID across reuse


def _query_compute_apps() -> dict[int, int]:
    """pid -> VRAM bytes. used_gpu_memory is reported in MiB."""
    res = run(
        ["nvidia-smi", "--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"],
        timeout=20,
    )
    out: dict[int, int] = {}
    if not res.ok:
        return out
    for line in res.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(",")]
        try:
            pid = int(parts[0])
            mib = float(parts[1])
        except (ValueError, IndexError):
            continue
        out[pid] = int(mib * 1024 * 1024)
    return out


def _pmon_util() -> dict[int, float]:
    """pid -> SM utilization %. `nvidia-smi pmon -c 1` columns: gpu pid type sm mem enc dec cmd."""
    res = run(["nvidia-smi", "pmon", "-c", "1"], timeout=20)
    out: dict[int, float] = {}
    if not res.ok:
        return out
    for line in res.stdout.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        cols = line.split()
        if len(cols) < 4:
            continue
        try:
            pid = int(cols[1])
        except ValueError:
            continue
        sm = cols[3]
        try:
            out[pid] = float(sm)
        except ValueError:
            out[pid] = 0.0  # '-' means no compute this sample -> treat as idle
    return out


def _container_of(pid: int) -> str | None:
    try:
        with open(f"/proc/{pid}/cgroup", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return None
    m = _DOCKER_CGROUP.search(text)
    if not m:
        return None
    cid = m.group(1)
    res = run(["docker", "inspect", "--format", "{{.Name}}", cid], timeout=15)
    if not res.ok:
        return None
    return res.stdout.strip().lstrip("/") or None


def _proc_uid(pid: int) -> int | None:
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("Uid:"):
                    return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        return None
    return None


def _student_user(container: str | None, pid: int) -> str | None:
    """Resolve the in-container username for a host PID's uid."""
    if not container:
        return None
    uid = _proc_uid(pid)
    if uid is None:
        return None
    res = run(["docker", "exec", container, "getent", "passwd", str(uid)], timeout=15)
    if not res.ok or ":" not in res.stdout:
        return None
    return res.stdout.split(":", 1)[0].strip() or None


def pid_start_time(pid: int) -> int | None:
    """Process start time (clock ticks since boot) from /proc/<pid>/stat field 22.

    Together with the PID this uniquely identifies a process: the kernel reuses PIDs, but a reused
    PID is a *new* process with a different start time.
    """
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as fh:
            data = fh.read()
    except OSError:
        return None
    # comm (field 2) may contain spaces/parens; split after the closing ')'.
    rparen = data.rfind(")")
    if rparen == -1:
        return None
    fields = data[rparen + 2:].split()
    # After comm, field 3 is state; starttime is field 22 overall => index 19 of this slice.
    try:
        return int(fields[19])
    except (IndexError, ValueError):
        return None


def kill_pid(pid: int, expected_start_time: int | None = None) -> bool:
    """Kill a host process (the agent runs as root). Returns True if the signal was sent.

    When expected_start_time is given, re-verify the PID still refers to the same process right
    before signalling (M-06): the kill decision was made minutes earlier and Linux recycles PIDs, so
    a mismatch means the original process already exited and we must NOT kill the impostor.
    """
    import os
    import signal

    if expected_start_time is not None:
        current = pid_start_time(pid)
        if current is None or current != expected_start_time:
            return False
    try:
        os.kill(pid, signal.SIGKILL)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def list_gpu_processes() -> list[dict]:
    vram = _query_compute_apps()
    util = _pmon_util()
    procs: list[dict] = []
    for pid, vram_bytes in vram.items():
        container = _container_of(pid)
        procs.append(
            asdict(
                GpuProcess(
                    pid=pid,
                    vram_bytes=vram_bytes,
                    util=util.get(pid),
                    container=container,
                    user=_student_user(container, pid),
                    start_time=pid_start_time(pid),
                )
            )
        )
    return procs
