import argparse
from core.utils.arg_validator import validate_args
from core.utils.mode_utils import handle_manual_mode, handle_csv_mode


def main():
    parser = argparse.ArgumentParser(
        description="Deploy Docker containers for users from a CSV file."
    )
    parser.add_argument(
        "--mode",
        type=str,
        choices=["group", "single", "manual"],
        required=True,
        help="Deployment mode: group (all groups), single (one group), or manual (direct params for group)",
    )
    parser.add_argument(
        "--image",
        type=str,
        default="custom-ssh",
        help="Docker image to deploy (default: custom-ssh)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=50000,
        help="Starting host port number (default: 50000)",
    )

    parser.add_argument(
        "--groupID",
        type=int,
        help="Deploy container for a specific group by index in CSV (for single mode)",
    )
    parser.add_argument(
        "--manual-username1",
        type=str,
        help="First username for manual group deployment",
    )
    parser.add_argument(
        "--manual-username2",
        type=str,
        help="Second username for manual group deployment",
    )
    parser.add_argument(
        "--manual-username3",
        type=str,
        help="Third username for manual group deployment",
    )
    parser.add_argument(
        "--cpu",
        type=str,
        default="4",
        help="CPU limit for containers (default: 4 cores)",
    )
    parser.add_argument(
        "--ram", type=str, default="8g", help="RAM limit for containers (default: 8GB)"
    )
    parser.add_argument(
        "--storage",
        type=str,
        default="50g",
        help="Storage limit for containers (default: 50GB)",
    )
    parser.add_argument(
        "--data-path",
        type=str,
        default="/nvme_data2/class_data",
        help="Path to the data folder for each team's container",
    )
    parser.add_argument(
        "--fs-path",
        type=str,
        default="/nvme_data1/docker.service",
        help="Path to the Docker filesystem directory",
    )
    args = parser.parse_args()

    # Validate arguments based on mode
    args = validate_args(args)

    mode = args.mode

    match mode:
        case "manual":
            # Pass args directly to handle_manual_mode for proper parameter handling
            handle_manual_mode(args)
        case _:
            handle_csv_mode(args)


if __name__ == "__main__":
    main()
