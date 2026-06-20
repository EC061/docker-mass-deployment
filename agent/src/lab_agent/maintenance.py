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
from .executors import zfs


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
