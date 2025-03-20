import argparse
import sys
from core.utils.csv_utils import find_input_csv, process_csv_and_deploy, save_updated_csv
from core.utils.docker_utils import deploy_container
from core.utils.arg_validator import validate_args

def main():
    parser = argparse.ArgumentParser(description='Deploy Docker containers for users from a CSV file.')
    parser.add_argument('--mode', type=str, choices=['group', 'single', 'manual'], required=True, 
                        help='Deployment mode: group (all users), single (one user), or manual (direct params)')
    parser.add_argument('--image', type=str, default="custom-ssh", help='Docker image to deploy (default: custom-ssh)')
    parser.add_argument('--port', type=int, default=50000, help='Starting host port number (default: 50000)')
    parser.add_argument('--user', type=str, help='Deploy container for a specific user by OrgDefinedId (for single mode)')
    parser.add_argument('--manual-username', type=str, help='Username for manual deployment')
    parser.add_argument('--manual-password', type=str, help='Password for manual deployment')
    parser.add_argument('--manual-docker-name', type=str, help='Docker container name for manual deployment')
    parser.add_argument('--cpu', type=str, default="4", help='CPU limit for containers (default: 4 cores)')
    parser.add_argument('--ram', type=str, default="8g", help='RAM limit for containers (default: 8GB)')
    parser.add_argument('--storage', type=str, default="50g", help='Storage limit for containers (default: 50GB)')
    args = parser.parse_args()
    
    # Validate arguments based on mode
    args = validate_args(args)

    mode = args.mode 
    start_port = args.port
    image_name = args.image
    cpu_limit = args.cpu
    ram_limit = args.ram
    storage_limit = args.storage

    if mode == 'manual':
        print(f"Manual mode: Deploying container for {args.manual_username}")
        success, _ = deploy_container(args.manual_username, args.manual_password, start_port, 
                                      args.manual_docker_name, image_name, cpu_limit, ram_limit, storage_limit)
        if success:
            print(f"Container for {args.manual_docker_name} deployed successfully on port {start_port}")
        else:
            print(f"Failed to deploy container for {args.manual_docker_name}")
    else:
        # Group or Single mode - process CSV
        input_file, output_file = find_input_csv()
        print(f"Processing input CSV: {input_file}")
        
        user_id = args.user if mode == 'single' else None
        
        if user_id:
            print(f"Single user mode: Deploying container only for user with ID '{user_id}'")
            output_file = f"{user_id}_container.csv"
        
        updated_df = process_csv_and_deploy(input_file, start_port, image_name, user_id, 
                                           cpu_limit, ram_limit, storage_limit)
        
        if updated_df is not None and not updated_df.empty:
            save_updated_csv(updated_df, output_file)
            print(f"Deployment complete. CSV saved as '{output_file}'.")
        else:
            print("No containers were deployed.")

if __name__ == "__main__":
    main()
