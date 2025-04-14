import glob
import os
import sys
import pandas as pd
import random
import string
from .docker_utils import deploy_container
from .arg_validator import validate_port


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
    data_path,
    group_id=None,
    cpu_limit="4",
    ram_limit="8g",
    storage_limit="50g",
    fs_path="/home/edward/docker-storage",
    dataframe=None,  # Add optional dataframe parameter
):
    """Process the CSV file or DataFrame and deploy containers."""
    if dataframe is not None:
        df = dataframe
        print("Processing provided DataFrame for deployment.")
    elif input_file:
        df = pd.read_csv(input_file, delimiter=",")
        print(f"Processing input CSV: {input_file}")
    else:
        print("Error: No input file or DataFrame provided.")
        return None

    # Assign Group ID if not present
    if "Group ID" not in df.columns:
        df["Group ID"] = df.index + 1

    current_port = start_port

    # If a specific group is requested, filter the DataFrame
    if group_id:
        # Filter by Group ID (index-based) instead of Team Number
        team_row = df[df["Group ID"] == int(group_id)]
        if team_row.empty:
            print(f"Group with Group ID '{group_id}' not found.")
            return None
        df = team_row.copy()
        print(f"Found group {group_id}. Processing single group deployment.")

    # Prepare output data
    output_data = []
    # Dynamically find member columns based on pattern 'Member' followed by digits or just 'Member'
    member_cols = [col for col in df.columns if col.strip().startswith("Member")]

    for index, row in df.iterrows():
        group_name = row["Group ID"]

        team_members = []
        for member_col in member_cols:
            # Check if column exists and value is not NaN/empty
            if (
                member_col in row
                and pd.notna(row[member_col])
                and str(row[member_col]).strip()
            ):
                member_name = str(row[member_col]).strip()
                # Use first name logic if space exists, otherwise use full name
                first_name = (
                    member_name.split(" ")[0].strip()
                    if " " in member_name
                    else member_name
                )
                password = generate_random_password(8)
                team_members.append({"username": first_name, "password": password})

        if not team_members:
            print(f"No valid members found for group {group_name}. Skipping...")
            continue

        current_port = validate_port(current_port)
        # Use a consistent naming scheme, prefixing with 'team_' if it's numeric
        docker_name = (
            f"team_{group_name}" if str(group_name).isdigit() else str(group_name)
        )

        temp_path = os.path.join(data_path, docker_name)
        if not os.path.exists(temp_path):
            os.makedirs(temp_path)
            os.chmod(temp_path, 0o777)  # Set permissions to rwxrwxrwx (777)
        success, container_id = deploy_container(
            team_members,
            current_port,
            docker_name,
            image_name,
            temp_path,
            cpu_limit,
            ram_limit,
            storage_limit,
            fs_path,
        )

        if not success:
            print(f"Error deploying container for {docker_name}. Exiting...")
            sys.exit(1)

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
