import sys
import socket
import os
import subprocess


def validate_args(args):
    """Validate command-line arguments based on the selected mode."""
    if args.mode == "manual":
        validate_manual_mode_args(args)
    elif args.mode == "single":
        validate_single_mode_args(args)
    validate_resource_limits(args)

    return args


def validate_manual_mode_args(args):
    """Validate arguments required for manual deployment mode."""
    if not all([args.manual_username, args.manual_password, args.manual_docker_name]):
        print(
            "Error: Manual mode requires --manual-username, --manual-password, and --manual-docker-name"
        )
        sys.exit(1)


def validate_single_mode_args(args):
    """Validate arguments required for single user deployment mode."""
    if not args.user:
        print("Error: Single mode requires --user parameter with OrgDefinedId")
        sys.exit(1)


def validate_resource_limits(args):
    """Validate resource limit arguments."""
    # Can be expanded with specific validations for CPU, RAM, and storage formats
    pass


def validate_port(port):
    """
    Validate if the port is within range and available.
    If not available, find the next available port.

    Args:
        port: The port number to validate

    Returns:
        int: An available port number
    """
    # Check if port is within valid range
    if port < 0 or port > 65535:
        print(f"Error: Port {port} is out of valid range (0-65535)")
        sys.exit(1)

    # Try to find an available port starting from the provided one
    current_port = port
    max_port = 65535

    while current_port <= max_port:
        try:
            # Try to open the socket to check if port is available
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("localhost", current_port))
                print(f"Port {current_port} is available and will be used")
                return current_port
        except OSError:
            # Port is not available, try the next one
            print(f"Port {current_port} is in use, trying {current_port + 1}")
            current_port += 1

    # If we've tried all ports and none are available
    print("Error: No available ports found in the valid range")
    sys.exit(1)


def validate_docker_storage_filesystem(path):
    """
    Validate that the docker storage path file system is XFS.

    Args:
        path: Path to the docker storage directory

    Returns:
        bool: True if the file system is XFS, False otherwise
    """
    # Check if path exists
    if not os.path.exists(path):
        print(f"Error: Docker storage path {path} does not exist")
        return False

    try:
        # Run df command to get filesystem type
        result = subprocess.run(
            ["df", "--output=fstype", path], capture_output=True, text=True, check=True
        )

        # Parse the output to get the filesystem type
        # The output will have a header line and a data line
        lines = result.stdout.strip().split("\n")
        if len(lines) < 2:
            print(f"Error: Could not determine file system type for {path}")
            return False

        fs_type = lines[1].strip()

        if fs_type.lower() != "xfs":
            print(
                f"Error: Docker storage path {path} uses {fs_type} file system. XFS is required."
            )
            return False

        return True

    except subprocess.CalledProcessError as e:
        print(f"Error checking file system type: {e}")
        return False
