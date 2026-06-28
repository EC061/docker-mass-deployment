"""In-container student user management via `docker exec`.

A student is a Linux user inside the lab container with:
  /home/<u>/scratch       -> /labusers/fast/<u>   (fast tier, a subdir of the lab's users mount)
  /home/<u>/cold-storage  -> /labusers/slow/<u>   (slow tier, a subdir of the lab's users mount)

There are no per-student datasets: /labusers/{fast,slow} are the lab's single users datasets,
already UID-shifted by Sysbox, so we create each student's scratch/cold-storage as a plain subdir
here and the chown to the student succeeds without host-side setup. We create the user, make the
subdirs + symlinks, set the password, and set umask. The script is piped via stdin so the password
never appears in the host process list.
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
    #
    # Users ARE granted sudo and added to the `docker` group so they can administer the box and use
    # the shared in-container Docker daemon (image/Dockerfile) when a project genuinely needs a
    # nested container. This is only safe because every lab container runs under the Sysbox runtime:
    # its user-namespace remap means container-root (which sudo and Docker grant) maps to an
    # UNPRIVILEGED host UID, so neither sudo nor the in-container daemon is a path to host root.
    # Note the tradeoff: a lab container is shared by all its students, so sudo means they are no
    # longer isolated from one another *within the lab* (host isolation is unaffected). umask 027
    # still keeps each student's files private by default.
    script = f"""set -e
u={username}
if ! id "$u" >/dev/null 2>&1; then useradd -m -s /bin/bash "$u"; fi
getent group docker >/dev/null 2>&1 || groupadd docker
usermod -aG sudo,docker "$u"
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
    # `|| true` so removing an already-absent user is not an error. When delete_home is set we also
    # wipe the student's scratch/cold-storage subdirs under /labusers (there are no per-student
    # datasets to destroy on the host — the data lives in these in-container subdirs). The username
    # is USERNAME_RE-validated above, so it is safe to interpolate directly.
    if delete_home:
        script = (
            f"userdel -r {username} 2>/dev/null || true\n"
            f"rm -rf /labusers/fast/{username} /labusers/slow/{username}\n"
        )
    else:
        script = f"userdel {username} 2>/dev/null || true\n"
    return _run_script(container, script)
