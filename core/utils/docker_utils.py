import subprocess
from .arg_validator import validate_port, validate_docker_storage_filesystem


def check_and_remove_container(container_name):
    """Check if container exists and remove it."""
    # Check if container exists
    check_cmd = [
        "docker",
        "ps",
        "-a",
        "--filter",
        f"name=^{container_name}$",
        "--format",
        "{{.Names}}",
    ]
    result = subprocess.run(check_cmd, capture_output=True, text=True)

    if container_name in result.stdout:
        print(f"Container '{container_name}' already exists. Removing it...")
        remove_cmd = ["docker", "rm", "-f", container_name]
        try:
            subprocess.run(remove_cmd, capture_output=True, text=True, check=True)
            print(f"Container '{container_name}' successfully removed.")
        except subprocess.CalledProcessError as e:
            print(f"Error removing container: {e.stderr}")
            return False

    return True


def deploy_container(
    team_members,
    port,
    docker_name,
    image_name,
    cpu_limit="4",
    ram_limit="8g",
    storage_limit="50g",
):
    """Deploy a Docker container for a team with at most three members."""
    # First check and remove existing container if it exists
    if not check_and_remove_container(docker_name):
        return False, ""
    # then validate the port
    port = validate_port(port)
    # and the storage filesystem
    file_system_check = validate_docker_storage_filesystem("/home/edward/docker")

    docker_cmd = [
        "docker",
        "run",
        "-d",
        "--name",
        docker_name,
        "-p",
        f"{port}:22",
        "--gpus",
        "all",
        "--runtime=nvidia",
        "--cpus",
        cpu_limit,
        "--memory",
        ram_limit,
    ]

    # Add storage option only if filesystem check passes
    if file_system_check:
        docker_cmd.extend(["--storage-opt", f"size={storage_limit}"])

    # Add team members environment variables (up to 3)
    if team_members and len(team_members) > 0:
        for i, member in enumerate(team_members[:3], 1):
            docker_cmd.extend(
                [
                    "-e",
                    f"USERNAME{i}={member['username']}",
                    "-e",
                    f"PASSWORD{i}={member['password']}",
                ]
            )
    else:
        return False, ""
    # Add restart policy and image name
    docker_cmd.extend(
        [
            "--restart",
            "unless-stopped",
            image_name,
        ]
    )

    try:
        result = subprocess.run(docker_cmd, capture_output=True, text=True, check=True)
        container_id = result.stdout.strip()
        print(
            f"Container {container_id} deployed for {docker_name} with {cpu_limit} CPUs, {ram_limit} RAM, and {storage_limit} storage."
        )
        success = True
    except subprocess.CalledProcessError as e:
        print(f"Error deploying container for {docker_name}: {e.stderr}")
        container_id = ""
        success = False

    return success, container_id
