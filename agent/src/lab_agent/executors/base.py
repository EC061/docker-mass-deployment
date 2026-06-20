"""Graceful subprocess wrapper used by every executor.

Captures stdout/stderr/exit-code and returns a structured result. Nothing here raises on a
non-zero exit; callers decide what a failure means. This is the foundation of the "graceful
failure everywhere" contract from the plan.
"""

from __future__ import annotations

import shlex
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass, field


@dataclass
class CommandResult:
    ok: bool
    args: list[str]
    returncode: int
    stdout: str = ""
    stderr: str = ""
    # Extra structured payload an executor may attach (parsed values, etc.).
    data: dict = field(default_factory=dict)

    @property
    def cmdline(self) -> str:
        return shlex.join(self.args)

    @property
    def logs(self) -> str:
        """Combined stdout+stderr suitable for shipping to the controller log."""
        parts = [f"$ {self.cmdline}"]
        if self.stdout.strip():
            parts.append(self.stdout.strip())
        if self.stderr.strip():
            parts.append(self.stderr.strip())
        return "\n".join(parts)


def run(args: Sequence[str], *, timeout: float = 120.0, input_text: str | None = None,
        check_message: str | None = None) -> CommandResult:
    """Run a command, never raising on failure.

    Returns CommandResult(ok=False, ...) on non-zero exit, missing binary, or timeout.
    """
    arglist = [str(a) for a in args]
    try:
        proc = subprocess.run(
            arglist,
            capture_output=True,
            text=True,
            timeout=timeout,
            input=input_text,
        )
    except FileNotFoundError as exc:
        return CommandResult(False, arglist, 127, "", f"command not found: {exc}")
    except subprocess.TimeoutExpired as exc:
        return CommandResult(False, arglist, 124, exc.stdout or "", f"timeout after {timeout}s")
    ok = proc.returncode == 0
    return CommandResult(ok, arglist, proc.returncode, proc.stdout or "", proc.stderr or "")
