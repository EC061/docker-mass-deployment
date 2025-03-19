#!/bin/bash
set -e

echo "Starting container initialization..."

# Default username if not provided
USERNAME=${USERNAME:-defaultuser}
echo "Using username: $USERNAME"

# Check if user exists, create if it doesn't
if ! id "$USERNAME" &>/dev/null; then
    echo "User $USERNAME does not exist. Creating now..."
    useradd -m -s /bin/bash "$USERNAME"
    adduser "$USERNAME" sudo
    echo "User $USERNAME created successfully."
fi

# Set password from environment variable if provided
if [ -n "$PASSWORD" ]; then
    echo "Setting password for user $USERNAME"
    echo "$USERNAME:$PASSWORD" | chpasswd
    if [ $? -eq 0 ]; then
        echo "Password set successfully"
    else
        echo "Failed to set password"
        exit 1
    fi
else
    echo "WARNING: No password provided. User will not have a password set."
fi

echo "Initialization complete. Starting service..."

# Start the command passed as arguments
exec "$@"
