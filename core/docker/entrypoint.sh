#!/bin/bash
set -e

USERNAME=${USERNAME:-defaultuser}
echo "Initializing container for user: $USERNAME"
# Check and create user if needed
if ! id "$USERNAME" &>/dev/null; then
    echo "User $USERNAME does not exist, creating..."
    useradd -m -s /bin/bash "$USERNAME"
    adduser "$USERNAME" sudo
    echo "User $USERNAME created and added to sudo group"
fi

if [ -n "$PASSWORD" ]; then
    echo "Setting password for $USERNAME..."
    echo "$USERNAME:$PASSWORD" | chpasswd
fi

echo "Initialization complete, starting service..."
exec "$@"
