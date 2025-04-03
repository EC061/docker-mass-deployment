import glob
import os
import sys
import pandas as pd
import random
import string
from .docker_utils import deploy_container
from core.utils.db_utils import add_container


def generate_random_password(length=8):
    """Generate a random password of specified length."""
    characters = string.ascii_letters + string.digits
    return "".join(random.choice(characters) for _ in range(length))


def find_input_csv():
    """Find the first CSV file in the current directory."""
    csv_files = glob.glob("*.csv")
    if not csv_files:
        raise FileNotFoundError("No CSV files found in the current directory")
    input_file = csv_files[0]
    output_file = f"{os.path.splitext(input_file)[0]}_updated.csv"
    return input_file, output_file


def process_csv_and_deploy(
    input_file,
    start_port,
    image_name,
    group_id=None,
    cpu_limit="4",
    ram_limit="8g",
    storage_limit="50g",
):
    """Process the CSV file and deploy containers for each team."""
    df = pd.read_csv(input_file, delimiter=",")
    df["Group ID"] = df.index + 1
    current_port = start_port

    # If a specific group is requested, filter the DataFrame
    if group_id:
        # Filter by Group ID (index-based) instead of Team Number
        team_row = df[df["Group ID"] == int(group_id)]
        if team_row.empty:
            print(f"Group with Group ID '{group_id}' not found in the CSV file.")
            return None
        df = team_row.copy()
        print(f"Found group {group_id}. Processing single group deployment.")

    # Prepare output data
    output_data = []
    member_cols = [col for col in df.columns if col.startswith("Member")]
    for index, row in df.iterrows():
        group_name = row["Group ID"]

        team_members = []
        for member_col in member_cols:
            if pd.notna(row.get(member_col)) and row.get(member_col, "").strip():
                member_name = row[member_col].strip()
                first_name = member_name.split(" ")[0].strip()
                password = generate_random_password(8)
                team_members.append({"username": first_name, "password": password})

        if not team_members:
            print(f"No valid members found for team {group_name}. Skipping...")
            continue

        # Create docker name from team number and name
        docker_name = f"team_{group_name}"

        success, container_id = deploy_container(
            team_members,
            current_port,
            docker_name,
            image_name,
            cpu_limit,
            ram_limit,
            storage_limit,
        )

        if not success:
            print(f"Error deploying container for {docker_name}. Exiting...")
            sys.exit(1)

        add_container(
            group_name=docker_name,
            members=team_members,
            port=current_port,
            image_name=image_name,
            cpu_limit=cpu_limit,
            ram_limit=ram_limit,
            storage_limit=storage_limit,
            container_id=container_id,
            status="running",
        )

        # Add team info to output data
        group_info = {
            "Group ID": docker_name,
            "Port": current_port,
        }

        # Add members and passwords as member1, password1, member2, password2, etc.
        for idx, member in enumerate(team_members, 1):
            group_info[f"Member{idx}"] = member["username"]
            group_info[f"Password{idx}"] = member["password"]
        output_data.append(group_info)
        current_port += 1

    # Create output dataframe
    output_df = pd.DataFrame(output_data)
    return output_df


def save_updated_csv(df, output_file):
    """Save the updated DataFrame to a CSV file."""
    df.to_csv(output_file, sep=",", index=False)
    print(f"Deployment complete. Updated CSV saved as '{output_file}'.")
