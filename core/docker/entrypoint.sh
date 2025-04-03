#!/bin/bash
set -e

# Define flag file to track initialization
INIT_FLAG="/var/lib/container-init-completed"

# Check if container was already initialized
if [ -f "$INIT_FLAG" ]; then
    echo "Container already initialized, skipping setup..."
else
    echo "Initializing container for group: $GROUP"

    function create_user() {
        local usr="$1"
        local pwd="$2"
        if [ -z "$usr" ]; then
            return
        fi
        if ! id "$usr" &>/dev/null; then
            useradd -m -s /bin/bash "$usr"
            adduser "$usr" sudo
            echo "User $usr created and added to sudo group"
        fi
        if [ -n "$pwd" ]; then
            echo "Setting password for $usr..."
            echo "$usr:$pwd" | chpasswd
        fi
        mkdir -p "/home/$usr/sample_project_torch"
        cd "/home/$usr/sample_project_torch"
        echo -e "torch==2.6.0\ntorchvision==0.21.0\ntorchaudio==2.6.0\npandas\nmatplotlib\nipython\nipykernel" >> "requirements.txt"
        mkdir -p "/home/$usr/sample_project_tf"
        cd "/home/$usr/sample_project_tf"
        echo -e "tensorflow[and-cuda]==2.19.0\npandas\nmatplotlib\nipython\nipykernel" >> "requirements.txt"
        chown -R "$usr:$usr" "/home/$usr"
    }

    # Only create users if the corresponding username variables are set
    if [ -n "$USERNAME" ]; then
        create_user "$USERNAME" "$PASSWORD"
    fi
    if [ -n "$USERNAME1" ]; then
        create_user "$USERNAME1" "$PASSWORD1"
    fi
    
    if [ -n "$USERNAME2" ]; then
        create_user "$USERNAME2" "$PASSWORD2"
    fi
    
    if [ -n "$USERNAME3" ]; then
        create_user "$USERNAME3" "$PASSWORD3"
    fi

    # Create flag file to indicate initialization is complete
    mkdir -p "$(dirname "$INIT_FLAG")"
    touch "$INIT_FLAG"
    echo "Initialization complete"
fi

echo "Starting service..."
exec "$@"
