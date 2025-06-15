import argparse
from core.utils.arg_validator import validate_args
from core.utils.mode_utils import handle_manual_mode, handle_csv_mode


def main():
    parser = argparse.ArgumentParser(
        description="Deploy Docker containers for users from a CSV file."
    )
    parser.add_argument(
        "--gui",
        action="store_true",
        help="Launch the terminal GUI interface",
    )
    parser.add_argument(
        "--mode",
        type=str,
        choices=["group", "single", "manual"],
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

    # Check if GUI mode is requested
    if args.gui:
        try:
            from gui import main as gui_main

            gui_main()
            return
        except ImportError as e:
            print(
                "GUI dependencies not installed. Please run: pip install -r requirements.txt"
            )
            print(f"Error: {e}")
            return
        except Exception as e:
            print(f"Error launching GUI: {e}")
            return

    # Existing CLI functionality
    if not args.mode:
        print("Error: --mode is required when not using --gui")
        parser.print_help()
        return

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
