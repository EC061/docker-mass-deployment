#!/bin/bash
set -e

# Lab container entrypoint. Students are NOT created here — the agent adds them as Linux users
# after the container starts (docker exec useradd + scratch/cold-storage symlinks). We only ensure
# the SSH runtime dirs and the data mount points exist, then exec sshd.

mkdir -p /var/run/sshd /labdata /labusers

# Generate host keys on first boot if the image didn't ship with them.
ssh-keygen -A >/dev/null 2>&1 || true

echo "Lab container ready; starting sshd."
exec "$@"
