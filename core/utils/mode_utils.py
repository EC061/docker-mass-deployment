from core.utils.csv_utils import find_input_csv, process_csv_and_deploy, save_updated_csv, read_deployment_record
from core.utils.docker_utils import deploy_container, delete_containers
import os

def handle_manual_mode(args):
    """
    Handle manual mode deployment with directly provided parameters.
    
    Args:
        args: Command line arguments
        
    Returns:
        bool: True if deployment was successful, False otherwise
    """
    print(f"Manual mode: Deploying container for {args.manual_username}")
    success, _ = deploy_container(
        args.manual_username, 
        args.manual_password, 
        args.port, 
        args.manual_docker_name, 
        args.image, 
        args.cpu, 
        args.ram, 
        args.storage
    )
    
    if success:
        print(f"Container for {args.manual_docker_name} deployed successfully on port {args.port}")
    else:
        print(f"Failed to deploy container for {args.manual_docker_name}")
    
    return success

def handle_csv_mode(args):
    """
    Handle group or single user mode deployments using CSV file.
    
    Args:
        args: Command line arguments
        
    Returns:
        bool: True if at least one container was deployed, False otherwise
    """
    # Find CSV files
    input_file, output_file = find_input_csv()
    print(f"Processing input CSV: {input_file}")
    
    # Determine if this is single user mode
    user_id = args.user if args.mode == 'single' else None
    
    if user_id:
        print(f"Single user mode: Deploying container only for user with ID '{user_id}'")
        output_file = f"{user_id}_container.csv"
    
    # Process CSV and deploy containers
    updated_df = process_csv_and_deploy(
        input_file, 
        args.port, 
        args.image, 
        user_id, 
        args.cpu, 
        args.ram, 
        args.storage
    )
    
    # Save the results
    if updated_df is not None and not updated_df.empty:
        save_updated_csv(updated_df, output_file)
        print(f"Deployment complete. CSV saved as '{output_file}'.")
        return True
    else:
        print("No containers were deployed.")
        return False