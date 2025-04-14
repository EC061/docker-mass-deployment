from core.utils.csv_utils import (
    find_input_csv,
    process_csv_and_deploy,
    save_updated_csv,
)
from core.utils.docker_utils import deploy_container


def handle_manual_mode(args):
    """
    Handle manual mode deployment with directly provided parameters.

    Args:
        args: Command line arguments

    Returns:
        bool: True if deployment was successful, False otherwise
    """
    # Create a unique docker name
    docker_name = f"manual_{args.manual_username1}"

    # Create team members list
    team_members = []
    if args.manual_username1:
        team_members.append({"username": args.manual_username1, "password": "password"})
    if args.manual_username2:
        team_members.append({"username": args.manual_username2, "password": "password"})
    if args.manual_username3:
        team_members.append({"username": args.manual_username3, "password": "password"})

    if not team_members:
        print("Error: No usernames provided for manual deployment")
        return False

    print(f"Manual mode: Deploying container for {args.manual_username1}")
    success, container_id = deploy_container(
        team_members,
        args.port,
        docker_name,
        args.image,
        args.cpu,
        args.ram,
        args.storage,
    )

    if success:
        print(f"Container for {docker_name} deployed successfully on port {args.port}")
    else:
        print(f"Failed to deploy container for {docker_name}")

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
    group_id = args.groupID if args.mode == "single" else None

    if group_id:
        print(
            f"Single user mode: Deploying container only for group with ID '{group_id}'"
        )
        output_file = f"{group_id}_container.csv"

    # Process CSV and deploy containers
    updated_df = process_csv_and_deploy(
        input_file,
        args.port,
        args.image,
        args.data_path,
        group_id,
        args.cpu,
        args.ram,
        args.storage,
        args.fs_path,
    )

    # Save the results
    if group_id:
        print(f"Deployment completefor group with ID '{group_id}'")
        save_updated_csv(updated_df, output_file)
        return True
    elif updated_df is not None and not updated_df.empty:
        save_updated_csv(updated_df, output_file)
        print(f"Deployment complete. CSV saved as '{output_file}'.")
        return True
    else:
        print("No containers were deployed.")
        return False
