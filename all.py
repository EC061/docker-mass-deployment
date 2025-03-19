import subprocess
import pandas as pd
import glob
import os
import argparse
import sys

def find_input_csv():
    """Find the first CSV file in the current directory."""
    csv_files = glob.glob("*.csv")
    if not csv_files:
        raise FileNotFoundError("No CSV files found in the current directory")
    input_file = csv_files[0]
    output_file = f"{os.path.splitext(input_file)[0]}_updated.csv"
    return input_file, output_file

def check_and_remove_container(container_name):
    """Check if container exists and remove it."""
    # Check if container exists
    check_cmd = ["docker", "ps", "-a", "--filter", f"name=^{container_name}$", "--format", "{{.Names}}"]
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

def deploy_container(username, password, port, docker_name, image_name, cpu_limit="4", ram_limit="8g", storage_limit="50g"):
    """Deploy a Docker container for a single user."""
    # First check and remove existing container if it exists
    if not check_and_remove_container(docker_name):
        return False, ""
    
    docker_cmd = [
        "docker", "run", "-d",
        "--name", docker_name,
        "-p", f"{port}:22",
        "--gpus", "all",
        "--runtime=nvidia",
        "--cpus", cpu_limit,
        "--memory", ram_limit,
        # "--storage-opt", f"size={storage_limit}",
        "-e", f"USERNAME={username}",
        "-e", f"PASSWORD={password}",
        "-e", "ENABLE_PASSWORD_AUTH=true",  # Explicitly enable password authentication
        "-e", "PERMIT_ROOT_LOGIN=true",     # Enable root login if needed
        "--restart", "unless-stopped",      # Ensure container restarts if SSH crashes
        image_name
    ]
    
    print(f"Deploying container for {username} on host port {port}...")
    try:
        result = subprocess.run(docker_cmd, capture_output=True, text=True, check=True)
        container_id = result.stdout.strip()
        print(f"Container {container_id} deployed for {username} with {cpu_limit} CPUs, {ram_limit} RAM, and {storage_limit} storage.")
        success = True
    except subprocess.CalledProcessError as e:
        print(f"Error deploying container for {username}: {e.stderr}")
        container_id = ""
        success = False
    
    return success, container_id

def process_csv_and_deploy(input_file, start_port, image_name, user_id=None, cpu_limit="4", ram_limit="8g", storage_limit="50g"):
    """Process the CSV file and deploy containers for each user."""
    df = pd.read_csv(input_file, delimiter=",")
    df["HostPort"] = None

    current_port = start_port
    
    # If a specific user is requested, filter the DataFrame
    if user_id:
        user_row = df[df["OrgDefinedId"].str.strip() == ("#" + user_id)]
        if user_row.empty:
            print(f"User with OrgDefinedId '{user_id}' not found in the CSV file.")
            return None
        df = user_row.copy()
        print(f"Found user {user_id}. Processing single user deployment.")

    for index, row in df.iterrows():
        print(row)
        last_name = row["Last Name"].strip()
        first_name = row["First Name"].strip()
        org_defined_id = row["OrgDefinedId"].strip()
        password = org_defined_id.replace("#", "")
        print(password)
        docker_name = f"{last_name}_{first_name}_{password}"
        username = f"{last_name}"

        
        success, _ = deploy_container(username, password, current_port, docker_name, image_name,
                                     cpu_limit, ram_limit, storage_limit)
        if not success:
            print(f'Error deploying container for {docker_name}. Exiting...')
            sys.exit(1)
        df.at[index, "HostPort"] = current_port
        current_port += 1
    
    filtered_df = df[["First Name", "Last Name", "HostPort"]]
    return filtered_df

def save_updated_csv(df, output_file):
    """Save the updated DataFrame to a CSV file."""
    df.to_csv(output_file, sep="\t", index=False)
    print(f"Deployment complete. Updated CSV saved as '{output_file}'.")

def main():
    parser = argparse.ArgumentParser(description='Deploy Docker containers for users from a CSV file.')
    parser.add_argument('--image', type=str, default="custom-ssh", help='Docker image to deploy (default: custom-ssh)')
    parser.add_argument('--port', type=int, default=50000, help='Starting host port number (default: 50000)')
    parser.add_argument('--user', type=str, help='Deploy container for a specific user by OrgDefinedId')
    parser.add_argument('--cpu', type=str, default="4", help='CPU limit for containers (default: 4 cores)')
    parser.add_argument('--ram', type=str, default="8g", help='RAM limit for containers (default: 8GB)')
    parser.add_argument('--storage', type=str, default="50g", help='Storage limit for containers (default: 50GB)')
    args = parser.parse_args()

    start_port = args.port
    user_id = args.user
    cpu_limit = args.cpu
    ram_limit = args.ram
    storage_limit = args.storage
    image_name = args.image

    input_file, output_file = find_input_csv()
    print(f"Processing input CSV: {input_file}")
    
    if user_id:
        print(f"Single user mode: Deploying container only for user with ID '{user_id}'")
        output_file = f"{user_id}_container.csv"
    
    updated_df = process_csv_and_deploy(input_file, start_port,image_name, user_id, 
                                       cpu_limit, ram_limit, storage_limit)
    
    if updated_df is not None and not updated_df.empty:
        save_updated_csv(updated_df, output_file)
        print(f"Deployment complete. CSV saved as '{output_file}'.")
    else:
        print("No containers were deployed.")

if __name__ == "__main__":
    main()