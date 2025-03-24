#!/bin/bash
set -e
# echo "Initializing container for group: $GROUP"
echo "Initializing container for user: $USERNAME"

# Add user and confifure password
if ! id "$USERNAME" &>/dev/null; then
    useradd -m -s /bin/bash "$USERNAME"
    adduser "$USERNAME" sudo
    echo "User $USERNAME created and added to sudo group"
fi
if [ -n "$PASSWORD" ]; then
    echo "Setting password for $USERNAME..."
    echo "$USERNAME:$PASSWORD" | chpasswd
fi

# Create sample project with pytorch
mkdir -p "/home/$USERNAME/sample_project_torch"
cd "/home/$USERNAME/sample_project_torch"
echo -e "torch==2.6.0\ntorchvision==0.21.0\ntorchaudio==2.6.0\npandas\nmatplotlib\nipython\nipykernel" >> "requirements.txt"

# Create sample project with tensorflow
mkdir -p "/home/$USERNAME/sample_project_tf"
cd "/home/$USERNAME/sample_project_tf"
echo -e "tensorflow[and-cuda]==2.19.0\npandas\nmatplotlib\nipython\nipykernel" >> "requirements.txt"

echo "Initialization complete, starting service..."
exec "$@"
