"""Node maintenance handlers (currently: ZFS scrub).

The controller decides *when* to scrub (a schedule in its Settings) and enqueues a ``node.scrub``
task; the agent just kicks off the scrub here and returns immediately — a scrub runs for hours, so
we never block the task on it. Progress and the final error count are reported back through the
regular heartbeat telemetry (``scrub`` field), where the controller alerts admins if errors appear.

Only ZFS pools are scrubbed. A node whose cold storage is an SMB mount has no slow pool to scrub
(``cfg.scrub_pools`` excludes it), and that share is the external storage owner's responsibility.
"""

from __future__ import annotations

from typing import Any

from .config import AgentConfig
from .executors import docker, zfs


def run_apt_upgrade(cfg: AgentConfig, lab: str, *, timeout: float = 1800.0) -> tuple[bool, str]:
    """Patch one lab's running container in place: ``apt-get update && apt-get -y upgrade``.

    This runs as container-root via ``docker exec`` (the container's PID-1 is root, so no sudo is
    needed), and patches the *running* container's writable layer — not the image. That is what
    lets the base image stay pinned and frozen for 1-2 years while security updates still land
    every week: the digest never has to be bumped for a CVE.

    Returns ``(ok, note)`` and never raises, so the caller's weekly loop survives one bad lab. A
    non-interactive frontend + ``--force-confold`` keep dpkg from blocking on config prompts.
    """
    name = docker.container_name(lab)
    if not docker.container_exists(name):
        return False, f"lab '{lab}' container not running; apt upgrade skipped"
    env = ["env", "DEBIAN_FRONTEND=noninteractive"]
    updated = docker.exec_in(name, [*env, "apt-get", "update"], timeout=timeout)
    if not updated.ok:
        return False, f"apt-get update failed for lab '{lab}': {updated.logs}"
    upgraded = docker.exec_in(
        name,
        [*env, "apt-get", "-y", "-o", "Dpkg::Options::=--force-confold", "upgrade"],
        timeout=timeout,
    )
    if not upgraded.ok:
        return False, f"apt-get upgrade failed for lab '{lab}': {upgraded.logs}"
    return True, f"patched lab '{lab}' (apt-get update && upgrade)"


def run_scrub(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Dispatcher handler for node.scrub. Starts a scrub on each ZFS pool this node owns."""
    requested = params.get("pools")
    pools = [p for p in (requested or cfg.scrub_pools) if p in cfg.scrub_pools]
    started: dict[str, bool] = {}
    for pool in pools:
        started[pool] = zfs.start_scrub(pool)
    status = [zfs.scrub_status(p).to_dict() for p in pools]
    note = "started scrub on " + (", ".join(pools) if pools else "no pools (none scrubbable)")
    return {"started": started, "status": status}, note
