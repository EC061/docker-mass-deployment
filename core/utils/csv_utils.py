import glob
import os
import sys
import pandas as pd
from .docker_utils import deploy_container

def find_input_csv():
    """Find the first CSV file in the current directory."""
    csv_files = glob.glob("*.csv")
    if not csv_files:
        raise FileNotFoundError("No CSV files found in the current directory")
    input_file = csv_files[0]
    output_file = f"{os.path.splitext(input_file)[0]}_updated.csv"
    return input_file, output_file

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
    df.to_csv(output_file, sep=",", index=False)
    print(f"Deployment complete. Updated CSV saved as '{output_file}'.")
