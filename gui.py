#!/usr/bin/env python3
"""
Command-line GUI for Docker Container Management
"""
import curses
import subprocess
import json
import sys
from typing import List, Dict
import time


class DockerContainerManager:
    def __init__(self, stdscr):
        self.stdscr = stdscr
        self.containers = []
        self.selected_index = 0
        self.menu_items = ["View Running Containers", "Exit"]
        self.in_container_view = False
        self.in_stats_view = False
        self.container_selected_index = 0
        self.current_stats = None
        self.status_message = ""
        self.status_timeout = 0
        
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

    def run(self):
        """Main application loop"""
        while True:
            try:
                if self.in_stats_view:
                    self.draw_stats_view()
                elif self.in_container_view:
                    self.draw_container_view()
                else:
                    self.draw_main_menu()
                
                key = self.stdscr.getch()
                
                if key == ord('q'):
                    break
                
                elif not self.in_container_view and not self.in_stats_view:
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
                        elif self.selected_index == 1:  # Exit
                            break
                
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
