"""In-container account management for flattened fast/cold storage.

A student is a Linux user inside the lab container with:
  /home/<u>               is the persistent fast directory
  /home/<u>/cold-storage  -> /cold-storage/<u>

There are no per-student datasets. The agent creates the storage directories on the host with
daemon user-namespace-remapped numeric ownership before creating this account. The script is piped
via stdin so the password never appears in the host process list.
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


MIN_STUDENT_UID = 10_000
MAX_STUDENT_UID = 59_999


def validate_uid(uid: int, gid: int) -> None:
    if uid != gid or not MIN_STUDENT_UID <= uid <= MAX_STUDENT_UID:
        raise DockerError(
            f"student uid/gid must match and be in {MIN_STUDENT_UID}..{MAX_STUDENT_UID}"
        )


def add_user(container: str, username: str, password: str, uid: int, gid: int) -> CommandResult:
    validate_username(username)
    validate_uid(uid, gid)
    # Password is embedded in the stdin-piped script body, never in argv.
    #
    # Full sudo is intentionally retained. Docker's daemon-wide userns-remap maps container root to
    # an unprivileged host uid; students remain mutually trusted within their shared lab container.
    script = f"""set -e
u={username}
existing_group=$(getent group {gid} | cut -d: -f1 || true)
if [ -z "$existing_group" ]; then groupadd -g {gid} "$u"; else test "$existing_group" = "$u"; fi
if ! id "$u" >/dev/null 2>&1; then
  useradd -M -d /home/"$u" -u {uid} -g {gid} -s /bin/bash "$u"
  cp -a -n /etc/skel/. /home/"$u"/
  chown -R {uid}:{gid} /home/"$u"/
fi
test "$(id -u "$u")" = "{uid}"
test "$(id -g "$u")" = "{gid}"
usermod -aG sudo "$u"
chmod 0700 /home/"$u"
if [ -e /home/"$u"/cold-storage ] && [ ! -L /home/"$u"/cold-storage ]; then
  echo "refusing to replace non-symlink cold-storage path" >&2
  exit 1
fi
ln -sfn /cold-storage/"$u" /home/"$u"/cold-storage
chown -h {uid}:{gid} /home/"$u"/cold-storage
grep -q '^umask ' /home/"$u"/.bashrc 2>/dev/null || echo 'umask 027' >> /home/"$u"/.bashrc
printf '%s:%s' "$u" {_shell_quote(password)} | chpasswd
"""
    return _run_script(container, script)


def set_password(container: str, username: str, password: str) -> CommandResult:
    validate_username(username)
    script = f"printf '%s:%s' {username} {_shell_quote(password)} | chpasswd\n"
    return _run_script(container, script)


def remove_user(
    container: str,
    username: str,
) -> CommandResult:
    """Remove only the in-container account. Host-side storage deletion is handled separately."""
    validate_username(username)
    # The home itself is the persistent fast bind mount. Never let userdel recursively remove it;
    # studentops performs an explicit guarded host-side deletion only when delete_data is requested.
    return _run_script(container, f"userdel {username} 2>/dev/null || true\n")
