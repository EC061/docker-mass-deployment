import sys
from core.utils.csv_utils import (
    find_input_csv,
    process_csv_and_deploy,
    save_updated_csv,
)
import pandas as pd  # Add pandas import


def handle_manual_mode(args):
    """
    Handle manual mode deployment by preparing data and calling process_csv_and_deploy.

    Args:
        args: Command line arguments

    Returns:
        bool: True if deployment was successful, False otherwise
    """
    print("Manual mode: Preparing deployment...")

    # Create team members list from args
    members = []
    if args.manual_username1:
        members.append(args.manual_username1)
    if args.manual_username2:
        members.append(args.manual_username2)
    if args.manual_username3:
        members.append(args.manual_username3)

    if not members:
        print("Error: No usernames provided for manual deployment")
        return False

    # Create a DataFrame mimicking the structure expected by process_csv_and_deploy
    manual_data = {"Group ID": [f"manual_{args.manual_username1}"]}
    for i, member in enumerate(members, 1):
        manual_data[f"Member{i}"] = [member]

    manual_df = pd.DataFrame(manual_data)

    # Call process_csv_and_deploy with the DataFrame
    updated_df = process_csv_and_deploy(
        input_file=None,  # No input file for manual mode
        start_port=args.port,
        image_name=args.image,
        data_path=args.data_path,
        group_id=None,  # Process the single group in the DataFrame
        cpu_limit=args.cpu,
        ram_limit=args.ram,
        storage_limit=args.storage,
        fs_path=args.fs_path,
        dataframe=manual_df,  # Pass the created DataFrame
    )

    # Check if the deployment was successful (updated_df should contain the deployed group)
    if updated_df is not None and not updated_df.empty:
        deployed_group = updated_df.iloc[0]
        print(
            f"Manual container '{deployed_group['Group ID']}' deployed successfully on port {deployed_group['Port']}."
        )
        # Optionally save the details to a file
        output_file = f"{deployed_group['Group ID']}_container.csv"
        save_updated_csv(updated_df, output_file)
        print(f"Deployment details saved to '{output_file}'.")
        return True
    else:
        print(f"Failed to deploy manual container for user {args.manual_username1}")
        return False


def handle_csv_mode(args):
    """
    Handle group or single user mode deployments using CSV file.

    Args:
        args: Command line arguments

    Returns:
        bool: True if at least one container was deployed, False otherwise
    """
    # Find CSV files
    try:
        input_file, output_file = find_input_csv()
    except FileNotFoundError as e:
        print(f"Error: {e}")
        sys.exit(1)

    # Determine if this is single user mode
    group_id = args.groupID if args.mode == "single" else None

    if group_id:
        print(
            f"Single user mode: Deploying container only for group with ID '{group_id}'"
        )
        # Adjust output file name for single group deployment
        output_file = f"group_{group_id}_container.csv"

    # Process CSV and deploy containers
    updated_df = process_csv_and_deploy(
        input_file=input_file,  # Pass the found CSV file path
        start_port=args.port,
        image_name=args.image,
        data_path=args.data_path,
        group_id=group_id,  # Pass group_id for filtering if in single mode
        cpu_limit=args.cpu,
        ram_limit=args.ram,
        storage_limit=args.storage,
        fs_path=args.fs_path,
        dataframe=None,  # Explicitly set dataframe to None when using input_file
    )

    # Save the results
    if updated_df is not None and not updated_df.empty:
        if group_id:
            print(f"Deployment complete for group with ID '{group_id}'.")
        else:
            print("Deployment complete for all groups.")
        save_updated_csv(updated_df, output_file)
        return True
    elif group_id and (updated_df is None or updated_df.empty):
        # Specific message if the single group wasn't found or failed
        print(
            f"Could not deploy container for group ID '{group_id}'. Check CSV or logs."
        )
        return False
    else:
        print("No containers were deployed based on the CSV.")
        return False
