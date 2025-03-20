import argparse
from core.utils.arg_validator import validate_args
from core.utils.mode_utils import handle_manual_mode, handle_csv_mode
from core.utils.db_utils import init_db

def main():
    # Initialize the database
    init_db()
    
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
    parser.add_argument('--list-containers', action='store_true', help='List all containers in the database')
    args = parser.parse_args()
    
    # Validate arguments based on mode
    args = validate_args(args)

    # Handle listing containers if requested
    if hasattr(args, 'list_containers') and args.list_containers:
        from core.utils.db_utils import get_all_containers
        containers = get_all_containers()
        print(f"Total containers: {len(containers)}")
        for container in containers:
            print(f"Name: {container['container_name']}, User: {container['username']}, Port: {container['port']}, Status: {container['status']}")
        return

    mode = args.mode 
    start_port = args.port
    image_name = args.image
    cpu_limit = args.cpu
    ram_limit = args.ram
    storage_limit = args.storage

    if mode == 'manual':
        handle_manual_mode(args.manual_username, args.manual_password, start_port, 
                           args.manual_docker_name, image_name, cpu_limit, ram_limit, storage_limit)
    else:
        # Group or Single mode - process CSV
        user_id = args.user if mode == 'single' else None
        handle_csv_mode(start_port, image_name, user_id, cpu_limit, ram_limit, storage_limit)

if __name__ == "__main__":
    main()
