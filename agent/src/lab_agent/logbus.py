"""Structured logging that ships log lines to the controller via the outbox.

Every log is also echoed to stderr so `journalctl -u lab-agent` shows it locally. Logs are enqueued
into the durable outbox, so they are delivered even if the controller is momentarily unreachable.
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from typing import Any

from .protocol import event_frame, log_frame, telemetry_frame

LEVELS = {"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40}


class LogBus:
    def __init__(self, node: str, sink: Callable[[dict[str, Any]], None], echo: bool = True):
        self.node = node
        self.sink = sink
        self.echo = echo

    def log(self, level: str, source: str, msg: str, *, lab: str | None = None,
            user: str | None = None, task_id: str | None = None, detail: str | None = None) -> None:
        if self.echo:
            line = f"[{level}] {source}: {msg}"
            print(line, file=sys.stderr, flush=True)
        self.sink(log_frame(self.node, level, source, msg, lab=lab, user=user,
                            task_id=task_id, detail=detail))

    def debug(self, source: str, msg: str, **kw: Any) -> None:
        self.log("DEBUG", source, msg, **kw)

    def info(self, source: str, msg: str, **kw: Any) -> None:
        self.log("INFO", source, msg, **kw)

    def warn(self, source: str, msg: str, **kw: Any) -> None:
        self.log("WARN", source, msg, **kw)

    def error(self, source: str, msg: str, **kw: Any) -> None:
        self.log("ERROR", source, msg, **kw)

    def event(self, kind: str, payload: dict[str, Any]) -> None:
        self.sink(event_frame(self.node, kind, payload))

    def telemetry(self, payload: dict[str, Any]) -> None:
        self.sink(telemetry_frame(self.node, payload))
