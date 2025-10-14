from core.utils.csv_utils import process_csv_and_deploy, save_updated_csv
from core.modes.base import collect_members, build_single_group_df


def handle_lab_mode(args):
    """
    Handle lab mode deployment by preparing data and calling process_csv_and_deploy.
    Mirrors manual mode for now, but prefers lab_* flags and prefixes group with 'lab_'.
    """
    print("Lab mode: Preparing deployment...")

    members = collect_members(args, prefer="lab")
    if not members:
        print("Error: No usernames provided for lab deployment")
        return False

    lab_df = build_single_group_df(members, prefix="lab")

    updated_df = process_csv_and_deploy(
        input_file=None,
        start_port=args.port,
        image_name=args.image,
        data_path=args.data_path,
        group_id=None,
        cpu_limit=args.cpu,
        ram_limit=args.ram,
        storage_limit=args.storage,
        fs_path=args.fs_path,
        dataframe=lab_df,
    )

    if updated_df is not None and not updated_df.empty:
        deployed_group = updated_df.iloc[0]
        print(
            f"Lab container '{deployed_group['Group ID']}' deployed successfully on port {deployed_group['Port']}."
        )
        output_file = f"{deployed_group['Group ID']}_container.csv"
        save_updated_csv(updated_df, output_file)
        print(f"Deployment details saved to '{output_file}'.")
        return True
    else:
        first_member = members[0] if members else "unknown"
        print(f"Failed to deploy lab container for user {first_member}")
        return False


