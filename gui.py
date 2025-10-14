#!/usr/bin/env python3
"""
Command-line GUI for Docker Container Management
"""
import curses
import subprocess
import json
import sys
import os
from typing import List, Dict
import time
import argparse
from core.utils.arg_validator import validate_args
from core.utils.mode_utils import handle_manual_mode, handle_csv_mode
from core.modes.lab import handle_lab_mode


class DockerContainerManager:
    def __init__(self, stdscr):
        self.stdscr = stdscr
        self.containers = []
        self.selected_index = 0
        self.menu_items = ["View Running Containers", "Create New Containers", "Exit"]
        self.in_container_view = False
        self.in_stats_view = False
        self.in_create_view = False
        self.in_create_form = False
        self.container_selected_index = 0
        self.current_stats = None
        self.status_message = ""
        self.status_timeout = 0
        self.create_modes = ["group", "single", "manual", "lab"]
        self.create_selected_index = 0
        self.form_fields = {}
        self.form_selected_field = 0
        self.form_editing = False
        self.form_edit_buffer = ""
        
        # Initialize colors
        curses.start_color()
        curses.init_pair(1, curses.COLOR_BLACK, curses.COLOR_WHITE)  # Selected item
        curses.init_pair(2, curses.COLOR_GREEN, curses.COLOR_BLACK)  # Success message
        curses.init_pair(3, curses.COLOR_RED, curses.COLOR_BLACK)    # Error message
        curses.init_pair(4, curses.COLOR_YELLOW, curses.COLOR_BLACK) # Warning message
        curses.init_pair(5, curses.COLOR_BLUE, curses.COLOR_BLACK)   # Info message
        
        # Set up the screen
        curses.curs_set(0)  # Hide cursor
        self.stdscr.keypad(True)
        
        # Initialize form fields with default values
        self.initialize_form_fields()
        
    def get_running_containers(self) -> List[Dict]:
        """Get list of running Docker containers"""
        try:
            result = subprocess.run(
                ['docker', 'ps', '--format', 'json'],
                capture_output=True,
                text=True,
                check=True
            )
            
            containers = []
            if result.stdout.strip():
                for line in result.stdout.strip().split('\n'):
                    if line.strip():
                        container = json.loads(line)
                        # Format the CreatedAt field to be more readable
                        if 'CreatedAt' in container:
                            created_at = container['CreatedAt']
                            # Extract just the date part if it's a full timestamp
                            if 'T' in created_at:
                                container['CreatedAt'] = created_at.split('T')[0]
                        containers.append(container)
            
            return containers
        except subprocess.CalledProcessError as e:
            self.set_status_message(f"Error getting containers: {e}", "error")
            return []
        except json.JSONDecodeError as e:
            self.set_status_message(f"Error parsing container data: {e}", "error")
            return []
        except FileNotFoundError:
            self.set_status_message("Docker is not installed or not in PATH", "error")
            return []
    
    def filter_ports(self, ports_raw: str) -> str:
        """Filter ports to show only external:internal format"""
        if not ports_raw or ports_raw == 'None':
            return 'None'
        
        port_mappings = []
        
        # Split by comma to handle multiple port mappings
        port_entries = ports_raw.split(',')
        
        for entry in port_entries:
            entry = entry.strip()
            
            # Look for pattern: 0.0.0.0:external->internal
            if '0.0.0.0:' in entry and '->' in entry:
                # Extract external port (after "0.0.0.0:" and before "->")
                external_start = entry.find('0.0.0.0:') + 8
                external_end = entry.find('->')
                external_port = entry[external_start:external_end]
                
                # Extract internal port (after "->" and before any other characters like "/tcp")
                internal_start = external_end + 2
                internal_port = entry[internal_start:]
                
                port_mappings.append(f"{external_port}:{internal_port}")
        
        return ','.join(port_mappings) if port_mappings else 'None'
    
    def set_status_message(self, message: str, msg_type: str = "info"):
        """Set a status message with timeout"""
        self.status_message = message
        self.status_timeout = time.time() + 3  # Show for 3 seconds
        self.message_type = msg_type
    
    def draw_status_message(self):
        """Draw status message if within timeout"""
        if time.time() < self.status_timeout and self.status_message:
            height, width = self.stdscr.getmaxyx()
            # Choose color based on message type
            color = curses.color_pair(5)  # Default blue
            if self.message_type == "error":
                color = curses.color_pair(3)
            elif self.message_type == "success":
                color = curses.color_pair(2)
            elif self.message_type == "warning":
                color = curses.color_pair(4)
            
            # Truncate message if too long
            msg = self.status_message[:width-2]
            self.stdscr.addstr(height-1, 0, msg, color)
        elif time.time() >= self.status_timeout:
            self.status_message = ""
    
    def draw_main_menu(self):
        """Draw the main menu"""
        self.stdscr.clear()
        height, width = self.stdscr.getmaxyx()
        
        # Title
        title = "Docker Container Manager"
        self.stdscr.addstr(1, (width - len(title)) // 2, title, curses.A_BOLD)
        
        # Menu items
        start_y = 4
        for i, item in enumerate(self.menu_items):
            if i == self.selected_index:
                self.stdscr.addstr(start_y + i, 2, f"> {item}", curses.color_pair(1))
            else:
                self.stdscr.addstr(start_y + i, 2, f"  {item}")
        
        # Instructions
        instructions = [
            "",
            "Controls:",
            "↑/↓ - Navigate",
            "Enter - Select",
            "q - Quit"
        ]
        
        for i, instruction in enumerate(instructions):
            self.stdscr.addstr(start_y + len(self.menu_items) + 2 + i, 2, instruction)
        
        self.draw_status_message()
        self.stdscr.refresh()
    
    def draw_container_view(self):
        """Draw the container management view"""
        self.stdscr.clear()
        height, width = self.stdscr.getmaxyx()
        
        # Title
        title = "Running Docker Containers"
        self.stdscr.addstr(1, (width - len(title)) // 2, title, curses.A_BOLD)
        
        if not self.containers:
            self.stdscr.addstr(4, 2, "No running containers found.")
            self.stdscr.addstr(6, 2, "Press 'b' to go back to main menu")
        else:
            # Container list with header
            start_y = 3
            
            # Calculate column widths based on screen size
            max_id_len = 12
            max_name_len = min(10, width // 6)
            max_image_len = min(10, width // 6)
            max_status_len = min(20, width // 8)
            max_created_len = min(20, width // 8)
            max_ports_len = min(20, width // 6)
            
            # Header row
            header = f"{'ID':^{max_id_len + 2}} | {'NAME':^{max_name_len}} | {'IMAGE':^{max_image_len}} | {'STATUS':^{max_status_len}} | {'CREATED':^{max_created_len}} | {'PORTS (EXT:INT)':^{max_ports_len}}"
            self.stdscr.addstr(start_y, 2, header, curses.A_BOLD)
            
            # Separator line
            separator = "-" * min(len(header), width - 4)
            self.stdscr.addstr(start_y + 1, 2, separator)
            
            # Container rows
            for i, container in enumerate(self.containers):
                container_name = container.get('Names', 'Unknown')
                container_id = container.get('ID', 'Unknown')[:max_id_len]
                image = container.get('Image', 'Unknown')
                status = container.get('Status', 'Unknown')
                created = container.get('CreatedAt', 'Unknown')
                ports_raw = container.get('Ports', 'None')
                
                # Filter ports to show only external:internal format
                ports = self.filter_ports(ports_raw)
                
                # Truncate fields to fit columns
                container_name = container_name[:max_name_len]
                image = image[:max_image_len]
                status = status[:max_status_len]
                created = created[:max_created_len]
                ports = ports[:max_ports_len] if ports else 'None'
                
                line = f"{container_id:<{max_id_len}} | {container_name:<{max_name_len}} | {image:<{max_image_len}} | {status:<{max_status_len}} | {created:<{max_created_len}} | {ports:<{max_ports_len}}"
                
                if i == self.container_selected_index:
                    self.stdscr.addstr(start_y + 2 + i, 2, f"> {line}", curses.color_pair(1))
                else:
                    self.stdscr.addstr(start_y + 2 + i, 2, f"  {line}")
            
            # Action buttons for selected container
            if self.containers:
                actions_y = start_y + len(self.containers) + 4  # +4 for header, separator, and spacing
                self.stdscr.addstr(actions_y, 2, "Actions for selected container:")
                self.stdscr.addstr(actions_y + 1, 4, "v - View stats")
                self.stdscr.addstr(actions_y + 2, 4, "s - Stop")
                self.stdscr.addstr(actions_y + 3, 4, "t - Restart")
                self.stdscr.addstr(actions_y + 4, 4, "d - Delete")
                self.stdscr.addstr(actions_y + 5, 4, "r - Refresh")
        
        # Instructions
        instructions_y = height - 4
        self.stdscr.addstr(instructions_y, 2, "Controls:")
        self.stdscr.addstr(instructions_y + 1, 2, "↑/↓ - Navigate containers")
        self.stdscr.addstr(instructions_y + 2, 2, "b - Back to main menu")
        self.stdscr.addstr(instructions_y + 3, 2, "q - Quit")
        
        self.draw_status_message()
        self.stdscr.refresh()
    
    def confirm_action(self, action: str, container_name: str) -> bool:
        """Show confirmation dialog for destructive actions"""
        height, width = self.stdscr.getmaxyx()
        
        # Create a popup window
        popup_height = 7
        popup_width = min(60, width - 4)
        popup_y = (height - popup_height) // 2
        popup_x = (width - popup_width) // 2
        
        # Create window
        popup = curses.newwin(popup_height, popup_width, popup_y, popup_x)
        popup.box()
        
        # Add content
        popup.addstr(1, 2, f"Confirm {action}", curses.A_BOLD)
        popup.addstr(2, 2, f"Container: {container_name}")
        popup.addstr(3, 2, f"Are you sure you want to {action.lower()} this container?")
        popup.addstr(4, 2, "This action cannot be undone.")
        popup.addstr(5, 2, "Press 'y' to confirm, any other key to cancel")
        
        popup.refresh()
        
        # Wait for confirmation
        key = popup.getch()
        del popup
        
        return key == ord('y') or key == ord('Y')
    
    def stop_container(self, container_id: str, container_name: str):
        """Stop a Docker container"""
        if self.confirm_action("STOP", container_name):
            try:
                subprocess.run(['docker', 'stop', container_id], check=True, capture_output=True)
                self.set_status_message(f"Container {container_name} stopped successfully", "success")
            except subprocess.CalledProcessError as e:
                self.set_status_message(f"Error stopping container: {e}", "error")
        else:
            self.set_status_message("Stop operation cancelled", "info")
    
    def restart_container(self, container_id: str, container_name: str):
        """Restart a Docker container"""
        if self.confirm_action("RESTART", container_name):
            try:
                subprocess.run(['docker', 'restart', container_id], check=True, capture_output=True)
                self.set_status_message(f"Container {container_name} restarted successfully", "success")
            except subprocess.CalledProcessError as e:
                self.set_status_message(f"Error restarting container: {e}", "error")
        else:
            self.set_status_message("Restart operation cancelled", "info")
    
    def delete_container(self, container_id: str, container_name: str):
        """Delete a Docker container"""
        if self.confirm_action("DELETE", container_name):
            try:
                # Stop container first if running
                subprocess.run(['docker', 'stop', container_id], check=True, capture_output=True)
                # Remove container
                subprocess.run(['docker', 'rm', container_id], check=True, capture_output=True)
                self.set_status_message(f"Container {container_name} deleted successfully", "success")
            except subprocess.CalledProcessError as e:
                self.set_status_message(f"Error deleting container: {e}", "error")
        else:
            self.set_status_message("Delete operation cancelled", "info")
    
    def handle_container_action(self, key):
        """Handle actions on selected container"""
        if not self.containers or self.container_selected_index >= len(self.containers):
            return
        
        container = self.containers[self.container_selected_index]
        container_id = container.get('ID', '')
        container_name = container.get('Names', 'Unknown')
        
        if key == ord('s'):
            self.stop_container(container_id, container_name)
            # Refresh container list after action
            self.containers = self.get_running_containers()
            # Adjust selected index if necessary
            if self.container_selected_index >= len(self.containers):
                self.container_selected_index = max(0, len(self.containers) - 1)
                
        elif key == ord('t'):
            self.restart_container(container_id, container_name)
            # Refresh container list after action
            self.containers = self.get_running_containers()
            
        elif key == ord('d'):
            self.delete_container(container_id, container_name)
            # Refresh container list after action
            self.containers = self.get_running_containers()
            # Adjust selected index if necessary
            if self.container_selected_index >= len(self.containers):
                self.container_selected_index = max(0, len(self.containers) - 1)
        
        elif key == ord('r'):
            self.containers = self.get_running_containers()
            self.set_status_message("Container list refreshed", "success")
    
    def get_container_stats(self, container_id: str) -> Dict:
        """Get stats for a specific Docker container"""
        try:
            result = subprocess.run(
                ['docker', 'stats', container_id, '--no-stream', '--format', 'json'],
                capture_output=True,
                text=True,
                check=True
            )
            
            if result.stdout.strip():
                stats = json.loads(result.stdout.strip())
                return stats
            else:
                return {}
        except subprocess.CalledProcessError as e:
            self.set_status_message(f"Error getting stats: {e}", "error")
            return {}
        except json.JSONDecodeError as e:
            self.set_status_message(f"Error parsing stats data: {e}", "error")
            return {}
        except FileNotFoundError:
            self.set_status_message("Docker is not installed or not in PATH", "error")
            return {}

    def draw_stats_view(self):
        """Draw the container stats view"""
        self.stdscr.clear()
        height, width = self.stdscr.getmaxyx()
        
        if not self.containers or self.container_selected_index >= len(self.containers):
            self.stdscr.addstr(4, 2, "No container selected.")
            self.stdscr.addstr(6, 2, "Press 'b' to go back to container view")
            self.draw_status_message()
            self.stdscr.refresh()
            return
        
        container = self.containers[self.container_selected_index]
        container_name = container.get('Names', 'Unknown')
        container_id = container.get('ID', 'Unknown')
        
        # Title
        title = "Container Stats"
        self.stdscr.addstr(1, (width - len(title)) // 2, title, curses.A_BOLD)
        
        if self.current_stats:
            # Display stats in a formatted way
            start_y = 3
            
            # Container Name at the top
            stats_name = self.current_stats.get('Name', container_name)
            self.stdscr.addstr(start_y, 2, f"Name: {stats_name}", curses.A_BOLD)
            
            # Container ID
            self.stdscr.addstr(start_y + 1, 2, f"Container ID: {container_id}")
            
            # CPU Usage
            cpu_usage = self.current_stats.get('CPUPerc', 'N/A')
            self.stdscr.addstr(start_y + 3, 2, f"CPU Usage: {cpu_usage}", curses.A_BOLD)
            
            # Memory Usage
            mem_usage = self.current_stats.get('MemUsage', 'N/A')
            mem_perc = self.current_stats.get('MemPerc', 'N/A')
            self.stdscr.addstr(start_y + 4, 2, f"Memory Usage: {mem_usage} ({mem_perc})", curses.A_BOLD)
            
            # Network I/O
            net_io = self.current_stats.get('NetIO', 'N/A')
            self.stdscr.addstr(start_y + 5, 2, f"Network I/O: {net_io}")
            
            # Block I/O
            block_io = self.current_stats.get('BlockIO', 'N/A')
            self.stdscr.addstr(start_y + 6, 2, f"Block I/O: {block_io}")
            
            # PIDs
            pids = self.current_stats.get('PIDs', 'N/A')
            self.stdscr.addstr(start_y + 7, 2, f"PIDs: {pids}")
            
        else:
            self.stdscr.addstr(5, 2, "Loading stats...")
            
        # Instructions
        instructions_y = height - 6
        self.stdscr.addstr(instructions_y, 2, "Controls:")
        self.stdscr.addstr(instructions_y + 1, 2, "r - Refresh stats")
        self.stdscr.addstr(instructions_y + 2, 2, "b - Back to container view")
        self.stdscr.addstr(instructions_y + 3, 2, "q - Quit")
        
        self.draw_status_message()
        self.stdscr.refresh()

    def initialize_form_fields(self):
        """Initialize form fields with default values from main.py argument parser"""
        self.form_fields = {
            "image": "custom-ssh",
            "port": "50000",
            "cpu": "4",
            "ram": "8g",
            "storage": "50g",
            "data_path": "/nvme_data2/class_data",
            "fs_path": "/nvme_data1/docker.service",
            "groupID": "",
            "manual_username1": "",
            "manual_username2": "",
            "manual_username3": ""
        }
        
        # Field order for form navigation
        self.form_field_order = [
            "image", "port", "cpu", "ram", "storage", 
            "data_path", "fs_path", "groupID", 
            "manual_username1", "manual_username2", "manual_username3"
        ]
        
        # Labels for form fields
        self.form_field_labels = {
            "image": "Docker Image",
            "port": "Starting Port",
            "cpu": "CPU Limit",
            "ram": "RAM Limit",
            "storage": "Storage Limit", 
            "data_path": "Data Path",
            "fs_path": "Docker FS Path",
            "groupID": "Group ID (single mode)",
            "manual_username1": "Username 1 (manual)",
            "manual_username2": "Username 2 (manual)",
            "manual_username3": "Username 3 (manual)"
        }
        
        # Help text for form fields
        self.form_field_help = {
            "image": "Docker image to deploy (default: custom-ssh)",
            "port": "Starting host port number (default: 50000)",
            "cpu": "CPU limit for containers (default: 4 cores)",
            "ram": "RAM limit for containers (default: 8GB)",
            "storage": "Storage limit for containers (default: 50GB)",
            "data_path": "Path to the data folder for each team's container",
            "fs_path": "Path to the Docker filesystem directory",
            "groupID": "Deploy container for specific group by CSV index",
            "manual_username1": "First username for manual group deployment",
            "manual_username2": "Second username for manual group deployment",
            "manual_username3": "Third username for manual group deployment"
        }
        
    def get_relevant_fields_for_mode(self, mode):
        """Get relevant fields for the current mode"""
        common_fields = ["image", "port", "cpu", "ram", "storage", "data_path", "fs_path"]
        
        if mode == "group":
            return common_fields
        elif mode == "single":
            return common_fields + ["groupID"]
        elif mode == "manual":
            return common_fields + ["manual_username1", "manual_username2", "manual_username3"]
        elif mode == "manual":
            return common_fields + ["manual_username1", "manual_username2", "manual_username3"]
        elif mode == "lab":
            # Reuse the same username inputs for lab mode
            return common_fields + ["manual_username1", "manual_username2", "manual_username3"]
        else:
            return common_fields
    
    def draw_create_menu(self):
        """Draw the create containers mode selection menu"""
        self.stdscr.clear()
        height, width = self.stdscr.getmaxyx()
        
        # Title
        title = "Create New Containers"
        self.stdscr.addstr(1, (width - len(title)) // 2, title, curses.A_BOLD)
        
        # Mode selection
        start_y = 4
        self.stdscr.addstr(start_y, 2, "Select deployment mode:", curses.A_BOLD)
        
        for i, mode in enumerate(self.create_modes):
            mode_desc = {
                "group": "Deploy for all groups in CSV",
                "single": "Deploy for a specific group", 
                "manual": "Manual deployment with usernames",
                "lab": "Lab deployment (mirrors manual for now)"
            }
            
            if i == self.create_selected_index:
                self.stdscr.addstr(start_y + 2 + i, 2, f"> {mode.upper()}: {mode_desc[mode]}", curses.color_pair(1))
            else:
                self.stdscr.addstr(start_y + 2 + i, 2, f"  {mode.upper()}: {mode_desc[mode]}")
        
        # Instructions
        instructions = [
            "",
            "Controls:",
            "↑/↓ - Navigate",
            "Enter - Select mode",
            "b - Back to main menu",
            "q - Quit"
        ]
        
        for i, instruction in enumerate(instructions):
            self.stdscr.addstr(start_y + len(self.create_modes) + 3 + i, 2, instruction)
        
        self.draw_status_message()
        self.stdscr.refresh()
    
    def draw_create_form(self):
        """Draw the create containers configuration form"""
        self.stdscr.clear()
        height, width = self.stdscr.getmaxyx()
        
        # Title
        title = f"Create New Containers - {self.create_modes[self.create_selected_index].upper()} Mode"
        self.stdscr.addstr(1, (width - len(title)) // 2, title, curses.A_BOLD)
        
        # Get relevant fields for current mode
        relevant_fields = self.get_relevant_fields_for_mode(self.create_modes[self.create_selected_index])
        
        # Form fields
        start_y = 3
        for i, field in enumerate(relevant_fields):
            label = self.form_field_labels[field]
            value = self.form_fields[field]
            
            # Show current field being edited
            if i == self.form_selected_field:
                if self.form_editing:
                    # Show edit buffer when editing
                    display_value = self.form_edit_buffer
                    self.stdscr.addstr(start_y + i, 2, f"> {label:20}: {display_value}_", curses.color_pair(1))
                else:
                    self.stdscr.addstr(start_y + i, 2, f"> {label:20}: {value}", curses.color_pair(1))
            else:
                self.stdscr.addstr(start_y + i, 2, f"  {label:20}: {value}")
        
        # Help text for current field
        if relevant_fields:
            current_field = relevant_fields[self.form_selected_field]
            help_text = self.form_field_help[current_field]
            help_y = start_y + len(relevant_fields) + 1
            self.stdscr.addstr(help_y, 2, "Help:", curses.A_BOLD)
            self.stdscr.addstr(help_y + 1, 2, help_text)
        
        # Instructions
        instructions_y = height - 7
        self.stdscr.addstr(instructions_y, 2, "Controls:")
        if self.form_editing:
            self.stdscr.addstr(instructions_y + 1, 2, "Enter - Save field")
            self.stdscr.addstr(instructions_y + 2, 2, "Esc - Cancel editing")
        else:
            self.stdscr.addstr(instructions_y + 1, 2, "↑/↓ - Navigate fields")
            self.stdscr.addstr(instructions_y + 2, 2, "Enter - Edit field")
            self.stdscr.addstr(instructions_y + 3, 2, "c - Create containers")
            self.stdscr.addstr(instructions_y + 4, 2, "b - Back to mode selection")
            self.stdscr.addstr(instructions_y + 5, 2, "q - Quit")
        
        self.draw_status_message()
        self.stdscr.refresh()
    
    def validate_form_fields(self):
        """Validate form fields before creating containers"""
        mode = self.create_modes[self.create_selected_index]
        
        # Validate common required fields
        if not self.form_fields["image"].strip():
            return "Docker image cannot be empty"
        
        if not self.form_fields["port"].strip():
            return "Port cannot be empty"
        
        try:
            port = int(self.form_fields["port"])
            if port < 1 or port > 65535:
                return "Port must be between 1 and 65535"
        except ValueError:
            return "Port must be a valid number"
        
        if not self.form_fields["cpu"].strip():
            return "CPU limit cannot be empty"
        
        if not self.form_fields["ram"].strip():
            return "RAM limit cannot be empty"
        
        if not self.form_fields["storage"].strip():
            return "Storage limit cannot be empty"
        
        if not self.form_fields["data_path"].strip():
            return "Data path cannot be empty"
        
        if not self.form_fields["fs_path"].strip():
            return "Docker filesystem path cannot be empty"
        
        # Validate paths exist
        if not os.path.exists(self.form_fields["data_path"]):
            return f"Data path does not exist: {self.form_fields['data_path']}"
        
        if not os.access(self.form_fields["data_path"], os.W_OK):
            return f"Data path is not writable: {self.form_fields['data_path']}"
        
        if not os.path.exists(self.form_fields["fs_path"]):
            return f"Docker filesystem path does not exist: {self.form_fields['fs_path']}"
        
        # Validate Docker filesystem path matches Docker Root Dir
        try:
            result = subprocess.run(
                ['docker', 'info', '--format', '{{.DockerRootDir}}'],
                capture_output=True,
                text=True,
                check=True
            )
            docker_root_dir = os.path.normpath(result.stdout.strip())
            fs_path_normalized = os.path.normpath(self.form_fields["fs_path"])
            if docker_root_dir and fs_path_normalized != docker_root_dir:
                return f"Docker filesystem path does not match Docker Root Dir. Expected: {docker_root_dir}, Got: {fs_path_normalized}"
        except subprocess.CalledProcessError as e:
            return f"Failed to get Docker info: {e}"
        except FileNotFoundError:
            return "Docker is not installed or not in PATH"
        
        # Mode-specific validation
        if mode == "single":
            if not self.form_fields["groupID"].strip():
                return "Group ID is required for single mode"
            try:
                group_id = int(self.form_fields["groupID"])
                if group_id < 0:
                    return "Group ID must be a positive number"
            except ValueError:
                return "Group ID must be a valid number"
        
        elif mode == "manual":
            if not self.form_fields["manual_username1"].strip():
                return "At least one username is required for manual mode"
            
            # Check for duplicate usernames
            usernames = [
                self.form_fields["manual_username1"],
                self.form_fields["manual_username2"],
                self.form_fields["manual_username3"]
            ]
            non_empty_usernames = [stripped for stripped in (u.strip() for u in usernames) if stripped]
            if len(non_empty_usernames) != len(set(non_empty_usernames)):
                return "Duplicate usernames are not allowed"
        
        return None  # No validation errors
    
    def create_containers(self):
        """Create containers based on current form configuration"""
        try:
            # Validate form fields first
            validation_error = self.validate_form_fields()
            if validation_error:
                self.set_status_message(validation_error, "error")
                return
            
            # Create argparse Namespace object from form data
            args = argparse.Namespace()
            args.mode = self.create_modes[self.create_selected_index]
            args.image = self.form_fields["image"]
            args.port = int(self.form_fields["port"])
            args.cpu = self.form_fields["cpu"]
            args.ram = self.form_fields["ram"]
            args.storage = self.form_fields["storage"]
            args.data_path = self.form_fields["data_path"]
            args.fs_path = self.form_fields["fs_path"]
            
            # Set mode-specific arguments
            if args.mode == "single":
                args.groupID = int(self.form_fields["groupID"]) if self.form_fields["groupID"] else None
            else:
                args.groupID = None
                
            if args.mode == "manual":
                args.manual_username1 = self.form_fields["manual_username1"]
                args.manual_username2 = self.form_fields["manual_username2"]
                args.manual_username3 = self.form_fields["manual_username3"]
            elif args.mode == "lab":
                # Map form fields to lab-specific args while keeping manual None
                args.lab_username1 = self.form_fields["manual_username1"]
                args.lab_username2 = self.form_fields["manual_username2"]
                args.lab_username3 = self.form_fields["manual_username3"]
                args.manual_username1 = None
                args.manual_username2 = None
                args.manual_username3 = None
            else:
                args.manual_username1 = None
                args.manual_username2 = None
                args.manual_username3 = None
            
            # Show creating message
            self.set_status_message("Creating containers...", "info")
            self.stdscr.refresh()
            
            success = False
            if args.mode == "manual":
                success = handle_manual_mode(args)
            elif args.mode == "lab":
                success = handle_lab_mode(args)
            else:
                success = handle_csv_mode(args)
            
            if success:
                self.set_status_message("Containers created successfully!", "success")
                # Refresh container list
                self.containers = self.get_running_containers()
            else:
                self.set_status_message("Failed to create containers", "error")
                
        except ValueError as e:
            self.set_status_message(f"Invalid input: {e}", "error")
        except FileNotFoundError as e:
            self.set_status_message(f"File not found: {e}", "error")
        except PermissionError as e:
            self.set_status_message(f"Permission denied: {e}", "error")
        except subprocess.CalledProcessError as e:
            self.set_status_message(f"Command failed: {e}", "error")
        except Exception as e:
            self.set_status_message(f"Error: {e}", "error")
    
    def run(self):
        """Main application loop"""
        while True:
            try:
                if self.in_stats_view:
                    self.draw_stats_view()
                elif self.in_container_view:
                    self.draw_container_view()
                elif self.in_create_form:
                    self.draw_create_form()
                elif self.in_create_view:
                    self.draw_create_menu()
                else:
                    self.draw_main_menu()
                
                key = self.stdscr.getch()
                
                if key == ord('q'):
                    break
                
                elif not self.in_container_view and not self.in_stats_view and not self.in_create_view and not self.in_create_form:
                    # Main menu navigation
                    if key == curses.KEY_UP:
                        self.selected_index = (self.selected_index - 1) % len(self.menu_items)
                    elif key == curses.KEY_DOWN:
                        self.selected_index = (self.selected_index + 1) % len(self.menu_items)
                    elif key == curses.KEY_ENTER or key == 10:
                        if self.selected_index == 0:  # View Running Containers
                            self.containers = self.get_running_containers()
                            self.in_container_view = True
                            self.container_selected_index = 0
                        elif self.selected_index == 1:  # Create New Containers
                            self.in_create_view = True
                            self.create_selected_index = 0
                        elif self.selected_index == 2:  # Exit
                            break
                
                elif self.in_create_view and not self.in_create_form:
                    # Create mode selection navigation
                    if key == ord('b'):
                        self.in_create_view = False
                        self.selected_index = 0
                    elif key == curses.KEY_UP:
                        self.create_selected_index = (self.create_selected_index - 1) % len(self.create_modes)
                    elif key == curses.KEY_DOWN:
                        self.create_selected_index = (self.create_selected_index + 1) % len(self.create_modes)
                    elif key == curses.KEY_ENTER or key == 10:
                        self.in_create_form = True
                        self.form_selected_field = 0
                        self.form_editing = False
                
                elif self.in_create_form:
                    # Create form navigation
                    if key == ord('b') and not self.form_editing:
                        self.in_create_form = False
                    elif key == ord('c') and not self.form_editing:
                        self.create_containers()
                    elif key == 27:  # Escape key
                        if self.form_editing:
                            self.form_editing = False
                            self.form_edit_buffer = ""
                        else:
                            self.in_create_form = False
                    elif not self.form_editing:
                        # Form field navigation
                        relevant_fields = self.get_relevant_fields_for_mode(self.create_modes[self.create_selected_index])
                        if key == curses.KEY_UP:
                            self.form_selected_field = (self.form_selected_field - 1) % len(relevant_fields)
                        elif key == curses.KEY_DOWN:
                            self.form_selected_field = (self.form_selected_field + 1) % len(relevant_fields)
                        elif key == curses.KEY_ENTER or key == 10:
                            # Start editing field
                            field_name = relevant_fields[self.form_selected_field]
                            self.form_editing = True
                            self.form_edit_buffer = self.form_fields[field_name]
                            curses.curs_set(1)  # Show cursor
                    else:
                        # Field editing
                        if key == curses.KEY_ENTER or key == 10:
                            # Save field
                            relevant_fields = self.get_relevant_fields_for_mode(self.create_modes[self.create_selected_index])
                            field_name = relevant_fields[self.form_selected_field]
                            self.form_fields[field_name] = self.form_edit_buffer
                            self.form_editing = False
                            self.form_edit_buffer = ""
                            curses.curs_set(0)  # Hide cursor
                        elif key == curses.KEY_BACKSPACE or key == 127:
                            # Delete character
                            if self.form_edit_buffer:
                                self.form_edit_buffer = self.form_edit_buffer[:-1]
                        elif 32 <= key <= 126:  # Printable characters
                            self.form_edit_buffer += chr(key)
                
                elif self.in_container_view and not self.in_stats_view:
                    # Container view navigation
                    if key == ord('b'):
                        self.in_container_view = False
                        self.selected_index = 0
                    elif key == curses.KEY_UP and self.containers:
                        self.container_selected_index = (self.container_selected_index - 1) % len(self.containers)
                    elif key == curses.KEY_DOWN and self.containers:
                        self.container_selected_index = (self.container_selected_index + 1) % len(self.containers)
                    elif key in [ord('s'), ord('t'), ord('d'), ord('r')]:
                        self.handle_container_action(key)
                    elif key == ord('v'):  # View stats
                        if self.containers and self.container_selected_index < len(self.containers):
                            container = self.containers[self.container_selected_index]
                            self.current_stats = self.get_container_stats(container.get('ID', ''))
                            self.in_stats_view = True
                
                elif self.in_stats_view:
                    # Stats view navigation
                    if key == ord('b'):
                        self.in_stats_view = False
                    elif key == ord('r'):
                        if self.containers and self.container_selected_index < len(self.containers):
                            container = self.containers[self.container_selected_index]
                            self.current_stats = self.get_container_stats(container.get('ID', ''))
                            self.set_status_message("Stats refreshed", "success")
            
            except KeyboardInterrupt:
                break
            except Exception as e:
                self.set_status_message(f"Unexpected error: {e}", "error")


def main():
    """Main function to start the GUI"""
    try:
        # Check if Docker is available
        subprocess.run(['docker', '--version'], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("Error: Docker is not installed or not accessible.")
        print("Please install Docker and make sure it's in your PATH.")
        sys.exit(1)
    
    try:
        curses.wrapper(lambda stdscr: DockerContainerManager(stdscr).run())
    except KeyboardInterrupt:
        print("\nGoodbye!")
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
