"""In-container student user management via `docker exec`.

A student is a Linux user inside the lab container with:
  /home/<u>/scratch       -> /labusers/fast/<u>   (fast, per-student dataset)
  /home/<u>/cold-storage  -> /labusers/slow/<u>   (slow, per-student dataset)

The host-side ZFS datasets are created by the caller (studentops) before this runs; here we only
create the user, set the password, wire the symlinks, and set umask. The script is piped via stdin
so the password never appears in the host process list.
"""

from __future__ import annotations

import re

from .base import CommandResult
from .docker import DockerError, exec_in

USERNAME_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")


def validate_username(username: str) -> None:
    if not USERNAME_RE.match(username):
        raise DockerError(f"invalid username '{username}'")


def _shell_quote(value: str) -> str:
    """Single-quote a value for safe embedding in the /bin/sh script."""
    return "'" + value.replace("'", "'\\''") + "'"


def _run_script(container: str, script: str) -> CommandResult:
    res = exec_in(container, ["sh", "-s"], input_text=script)
    if not res.ok:
        raise DockerError(res.logs)
    return res


def add_user(container: str, username: str, password: str) -> CommandResult:
    validate_username(username)
    # Password is embedded in the stdin-piped script body, never in argv.
    # Students are NOT added to sudo (H-05): a brute-forced/shared student password would otherwise
    # grant container root and a host-escalation foothold. umask 027 keeps each student's files
    # private to themselves instead of world-writable.
    script = f"""set -e
u={username}
if ! id "$u" >/dev/null 2>&1; then useradd -m -s /bin/bash "$u"; fi
mkdir -p /labusers/fast/"$u" /labusers/slow/"$u"
chown "$u":"$u" /labusers/fast/"$u" /labusers/slow/"$u"
ln -sfn /labusers/fast/"$u" /home/"$u"/scratch
ln -sfn /labusers/slow/"$u" /home/"$u"/cold-storage
chown -h "$u":"$u" /home/"$u"/scratch /home/"$u"/cold-storage
grep -q '^umask ' /home/"$u"/.bashrc 2>/dev/null || echo 'umask 027' >> /home/"$u"/.bashrc
printf '%s:%s' "$u" {_shell_quote(password)} | chpasswd
"""
    return _run_script(container, script)


def set_password(container: str, username: str, password: str) -> CommandResult:
    validate_username(username)
    script = f"printf '%s:%s' {username} {_shell_quote(password)} | chpasswd\n"
    return _run_script(container, script)


def remove_user(container: str, username: str, *, delete_home: bool = False) -> CommandResult:
    validate_username(username)
    flag = "-r " if delete_home else ""
    # `|| true` so removing an already-absent user is not an error.
    script = f"userdel {flag}{username} 2>/dev/null || true\n"
    return _run_script(container, script)
