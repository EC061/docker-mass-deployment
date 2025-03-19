import sys

def validate_args(args):
    """Validate command-line arguments based on the selected mode."""
    if args.mode == 'manual':
        validate_manual_mode_args(args)
    elif args.mode == 'single':
        validate_single_mode_args(args)
    
    # Common validations for all modes
    validate_resource_limits(args)
    
    return args

def validate_manual_mode_args(args):
    """Validate arguments required for manual deployment mode."""
    if not all([args.manual_username, args.manual_password, args.manual_docker_name]):
        print("Error: Manual mode requires --manual-username, --manual-password, and --manual-docker-name")
        sys.exit(1)

def validate_single_mode_args(args):
    """Validate arguments required for single user deployment mode."""
    if not args.user:
        print("Error: Single mode requires --user parameter with OrgDefinedId")
        sys.exit(1)

def validate_resource_limits(args):
    """Validate resource limit arguments."""
    # Can be expanded with specific validations for CPU, RAM, and storage formats
    pass
