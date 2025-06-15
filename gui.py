from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, Container
from textual.widgets import (
    Button, DataTable, Static, Header, Footer, Input, Select, 
    Switch, Label, TabbedContent, TabPane, TextArea
)
from textual.screen import Screen, ModalScreen
from textual.binding import Binding
from textual.reactive import reactive
from rich.text import Text
import sys
from pathlib import Path

# Add the project root to Python path
sys.path.append(str(Path(__file__).parent.parent.parent))

from core.utils.container_monitor import (
    get_container_list, get_container_details, start_container,
    stop_container, restart_container, delete_container, 
    get_container_logs
)
from core.utils.mode_utils import handle_manual_mode, handle_csv_mode
from core.utils.csv_utils import find_input_csv


class ContainerActionScreen(ModalScreen):
    """Modal screen for container actions with confirmation."""
    
    def __init__(self, container_name: str, action: str, container_id: str = ""):
        super().__init__()
        self.container_name = container_name
        self.action = action
        self.container_id = container_id
        
    def compose(self) -> ComposeResult:
        with Container(id="action-dialog"):
            yield Static(f"Are you sure you want to {self.action} container '{self.container_name}'?")
            with Horizontal():
                yield Button("Yes", variant="error", id="confirm")
                yield Button("Cancel", variant="primary", id="cancel")
    
    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "confirm":
            self.dismiss(True)
        else:
            self.dismiss(False)


class ContainerDetailsScreen(ModalScreen):
    """Modal screen to show detailed container information."""
    
    def __init__(self, container_id: str):
        super().__init__()
        self.container_id = container_id
        
    def compose(self) -> ComposeResult:
        details = get_container_details(self.container_id)
        
        with Container(id="details-dialog"):
            yield Static("Container Details", classes="title")
            
            if details:
                with TabbedContent():
                    with TabPane("General", id="general"):
                        info_text = f"""
Name: {details['name']}
Image: {details['image']}
Status: {details['status']}
Running: {details['running']}
Started: {details['started_at']}
Ports: {', '.join(details['ports']) if details['ports'] else 'None'}
                        """
                        yield TextArea(info_text.strip(), read_only=True)
                    
                    with TabPane("Users", id="users"):
                        users_text = ""
                        for i in range(1, 4):
                            username_key = f"USERNAME{i}"
                            password_key = f"PASSWORD{i}"
                            if username_key in details['users']:
                                users_text += f"User {i}: {details['users'][username_key]}\n"
                                if password_key in details['users']:
                                    users_text += f"Password {i}: {details['users'][password_key]}\n"
                                users_text += "\n"
                        
                        if not users_text:
                            users_text = "No user information available"
                        
                        yield TextArea(users_text.strip(), read_only=True)
                    
                    with TabPane("Mounts", id="mounts"):
                        mounts_text = "\n".join(details['mounts']) if details['mounts'] else "No mounts"
                        yield TextArea(mounts_text, read_only=True)
                    
                    with TabPane("Logs", id="logs"):
                        logs = get_container_logs(self.container_id)
                        yield TextArea(logs, read_only=True)
            else:
                yield Static("Could not load container details")
            
            yield Button("Close", id="close")
    
    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "close":
            self.dismiss()


class CreateContainerScreen(ModalScreen):
    """Modal screen for creating new containers."""
    
    def compose(self) -> ComposeResult:
        with Container(id="create-dialog"):
            yield Static("Create New Container", classes="title")
            
            with TabbedContent():
                with TabPane("Manual Mode", id="manual"):
                    with Vertical():
                        yield Label("Username 1 (required):")
                        yield Input(placeholder="Enter first username", id="username1")
                        yield Label("Username 2 (optional):")
                        yield Input(placeholder="Enter second username", id="username2")
                        yield Label("Username 3 (optional):")
                        yield Input(placeholder="Enter third username", id="username3")
                        yield Label("Starting Port:")
                        yield Input(value="50000", id="port")
                        yield Label("Docker Image:")
                        yield Input(value="custom-ssh", id="image")
                        yield Label("CPU Limit:")
                        yield Input(value="4", id="cpu")
                        yield Label("RAM Limit:")
                        yield Input(value="8g", id="ram")
                        yield Label("Storage Limit:")
                        yield Input(value="50g", id="storage")
                        yield Label("Data Path:")
                        yield Input(value="/nvme_data2/class_data", id="data-path")
                        yield Label("Filesystem Path:")
                        yield Input(value="/nvme_data1/docker.service", id="fs-path")
                        yield Button("Create Manual Container", variant="success", id="create-manual")
                
                with TabPane("CSV Mode", id="csv"):
                    with Vertical():
                        yield Static("CSV Mode Options")
                        yield Label("Mode:")
                        yield Select([("All Groups", "group"), ("Single Group", "single")], id="csv-mode")
                        yield Label("Group ID (for single mode):")
                        yield Input(placeholder="Enter group ID", id="group-id")
                        yield Label("Starting Port:")
                        yield Input(value="50000", id="csv-port")
                        yield Label("Docker Image:")
                        yield Input(value="custom-ssh", id="csv-image")
                        yield Label("CPU Limit:")
                        yield Input(value="4", id="csv-cpu")
                        yield Label("RAM Limit:")
                        yield Input(value="8g", id="csv-ram")
                        yield Label("Storage Limit:")
                        yield Input(value="50g", id="csv-storage")
                        yield Label("Data Path:")
                        yield Input(value="/nvme_data2/class_data", id="csv-data-path")
                        yield Label("Filesystem Path:")
                        yield Input(value="/nvme_data1/docker.service", id="csv-fs-path")
                        yield Button("Create from CSV", variant="success", id="create-csv")
            
            with Horizontal():
                yield Button("Cancel", variant="primary", id="cancel")
    
    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "create-manual":
            self.create_manual_container()
        elif event.button.id == "create-csv":
            self.create_csv_container()
        elif event.button.id == "cancel":
            self.dismiss()
    
    def create_manual_container(self):
        """Create container in manual mode."""
        try:
            # Get form values
            username1 = self.query_one("#username1", Input).value.strip()
            username2 = self.query_one("#username2", Input).value.strip()
            username3 = self.query_one("#username3", Input).value.strip()
            port = self.query_one("#port", Input).value.strip()
            image = self.query_one("#image", Input).value.strip()
            cpu = self.query_one("#cpu", Input).value.strip()
            ram = self.query_one("#ram", Input).value.strip()
            storage = self.query_one("#storage", Input).value.strip()
            data_path = self.query_one("#data-path", Input).value.strip()
            fs_path = self.query_one("#fs-path", Input).value.strip()
            
            if not username1:
                self.notify("Username 1 is required", severity="error")
                return
            
            # Create args object
            class Args:
                def __init__(self):
                    self.mode = "manual"
                    self.manual_username1 = username1
                    self.manual_username2 = username2 if username2 else None
                    self.manual_username3 = username3 if username3 else None
                    self.port = int(port) if port.isdigit() else 50000
                    self.image = image or "custom-ssh"
                    self.cpu = cpu or "4"
                    self.ram = ram or "8g"
                    self.storage = storage or "50g"
                    self.data_path = data_path or "/nvme_data2/class_data"
                    self.fs_path = fs_path or "/nvme_data1/docker.service"
            
            args = Args()
            
            # Call the deployment function
            success = handle_manual_mode(args)
            if success:
                self.notify("Container created successfully!", severity="information")
                self.dismiss("refresh")
            else:
                self.notify("Failed to create container", severity="error")
                
        except Exception as e:
            self.notify(f"Error creating container: {str(e)}", severity="error")
    
    def create_csv_container(self):
        """Create container(s) from CSV."""
        try:
            # Check if CSV file exists
            try:
                input_file, output_file = find_input_csv()
            except FileNotFoundError:
                self.notify("No CSV file found in current directory", severity="error")
                return
            
            # Get form values
            mode = self.query_one("#csv-mode", Select).value
            group_id = self.query_one("#group-id", Input).value.strip()
            port = self.query_one("#csv-port", Input).value.strip()
            image = self.query_one("#csv-image", Input).value.strip()
            cpu = self.query_one("#csv-cpu", Input).value.strip()
            ram = self.query_one("#csv-ram", Input).value.strip()
            storage = self.query_one("#csv-storage", Input).value.strip()
            data_path = self.query_one("#csv-data-path", Input).value.strip()
            fs_path = self.query_one("#csv-fs-path", Input).value.strip()
            
            if mode == "single" and not group_id:
                self.notify("Group ID is required for single mode", severity="error")
                return
            
            # Create args object
            class Args:
                def __init__(self):
                    self.mode = mode
                    self.groupID = int(group_id) if group_id and group_id.isdigit() else None
                    self.port = int(port) if port.isdigit() else 50000
                    self.image = image or "custom-ssh"
                    self.cpu = cpu or "4"
                    self.ram = ram or "8g"
                    self.storage = storage or "50g"
                    self.data_path = data_path or "/nvme_data2/class_data"
                    self.fs_path = fs_path or "/nvme_data1/docker.service"
            
            args = Args()
            
            # Call the deployment function
            success = handle_csv_mode(args)
            if success:
                self.notify("Container(s) created successfully!", severity="information")
                self.dismiss("refresh")
            else:
                self.notify("Failed to create container(s)", severity="error")
                
        except Exception as e:
            self.notify(f"Error creating container(s): {str(e)}", severity="error")


class MonitorScreen(Screen):
    """Main monitoring screen showing container list and actions."""
    
    BINDINGS = [
        Binding("r", "refresh", "Refresh"),
        Binding("c", "create", "Create"),
        Binding("q", "quit", "Quit"),
    ]
    
    auto_refresh = reactive(True)
    
    def compose(self) -> ComposeResult:
        yield Header()
        
        with Container(id="main-container"):
            with Horizontal():
                # Left panel - Container list
                with Vertical(id="container-list"):
                    yield Static("Docker Containers", classes="panel-title")
                    table = DataTable(id="containers-table")
                    table.add_column("Name", width=20)
                    table.add_column("Status", width=15)
                    table.add_column("Image", width=15)
                    table.add_column("Ports", width=15)
                    table.add_column("Created", width=20)
                    yield table
                
                # Right panel - Actions
                with Vertical(id="actions-panel"):
                    yield Static("Container Actions", classes="panel-title")
                    yield Button("Refresh List", id="refresh-btn")
                    yield Button("Create New", id="create-btn", variant="success")
                    yield Static("Selected Container:", classes="section-title")
                    yield Static("None", id="selected-container")
                    yield Button("Start", id="start-btn", disabled=True)
                    yield Button("Stop", id="stop-btn", disabled=True)
                    yield Button("Restart", id="restart-btn", disabled=True)
                    yield Button("Delete", id="delete-btn", variant="error", disabled=True)
                    yield Button("Details", id="details-btn", disabled=True)
                    
                    # Auto-refresh toggle
                    with Horizontal():
                        yield Label("Auto-refresh:")
                        yield Switch(value=True, id="auto-refresh-switch")
        
        yield Footer()
    
    def on_mount(self) -> None:
        """Called when the screen is mounted."""
        self.refresh_containers()
        # Set up auto-refresh timer
        self.auto_refresh_timer = self.set_interval(2.0, self.auto_refresh_containers)
    
    def auto_refresh_containers(self) -> None:
        """Auto-refresh containers if enabled."""
        if self.auto_refresh:
            self.refresh_containers()
    
    def refresh_containers(self) -> None:
        """Refresh the container list."""
        table = self.query_one("#containers-table", DataTable)
        table.clear()
        
        containers = get_container_list()
        for container in containers:
            # Format the created time
            created = container.get('created', '')
            if created:
                try:
                    # Truncate to show only date and time
                    created = created.split('.')[0] if '.' in created else created
                    created = created.replace('T', ' ')[:19]
                except Exception:
                    pass
            
            # Format ports
            ports = container.get('ports', '')
            if '->' in ports:
                # Extract just the host port mapping
                port_parts = ports.split('->')
                if len(port_parts) >= 2:
                    ports = port_parts[0].strip()
            
            # Color status based on state
            status = container.get('status', '')
            if 'Up' in status:
                status_text = Text(status, style="green")
            elif 'Exited' in status:
                status_text = Text(status, style="red")
            else:
                status_text = Text(status, style="yellow")
            
            table.add_row(
                container['name'],
                status_text,
                container.get('image', ''),
                ports,
                created,
                key=container['id']
            )
    
    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        """Handle container selection."""
        if event.row_key:
            container_id = str(event.row_key.value)
            container_name = str(event.cell_value)
            
            # Update selected container display
            self.query_one("#selected-container", Static).update(container_name)
            
            # Enable action buttons
            self.query_one("#start-btn", Button).disabled = False
            self.query_one("#stop-btn", Button).disabled = False
            self.query_one("#restart-btn", Button).disabled = False
            self.query_one("#delete-btn", Button).disabled = False
            self.query_one("#details-btn", Button).disabled = False
            
            # Store selected container info
            self.selected_container_id = container_id
            self.selected_container_name = container_name
    
    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle button presses."""
        button_id = event.button.id
        
        if button_id == "refresh-btn":
            self.refresh_containers()
        elif button_id == "create-btn":
            self.action_create()
        elif button_id in ["start-btn", "stop-btn", "restart-btn", "delete-btn"]:
            if hasattr(self, 'selected_container_id'):
                action = button_id.replace('-btn', '')
                self.container_action(action)
        elif button_id == "details-btn":
            if hasattr(self, 'selected_container_id'):
                self.show_container_details()
    
    def on_switch_changed(self, event: Switch.Changed) -> None:
        """Handle auto-refresh toggle."""
        if event.switch.id == "auto-refresh-switch":
            self.auto_refresh = event.value
    
    async def container_action(self, action: str) -> None:
        """Perform container action with confirmation."""
        if not hasattr(self, 'selected_container_id'):
            return
        
        # Show confirmation dialog
        result = await self.push_screen_wait(
            ContainerActionScreen(
                self.selected_container_name, 
                action, 
                self.selected_container_id
            )
        )
        
        if result:
            success = False
            if action == "start":
                success = start_container(self.selected_container_id)
            elif action == "stop":
                success = stop_container(self.selected_container_id)
            elif action == "restart":
                success = restart_container(self.selected_container_id)
            elif action == "delete":
                success = delete_container(self.selected_container_id, force=True)
            
            if success:
                self.notify(f"Container {action}ed successfully", severity="information")
                self.refresh_containers()
            else:
                self.notify(f"Failed to {action} container", severity="error")
    
    async def show_container_details(self) -> None:
        """Show detailed container information."""
        if hasattr(self, 'selected_container_id'):
            await self.push_screen_wait(ContainerDetailsScreen(self.selected_container_id))
    
    async def action_create(self) -> None:
        """Show create container dialog."""
        result = await self.push_screen_wait(CreateContainerScreen())
        if result == "refresh":
            self.refresh_containers()
    
    def action_refresh(self) -> None:
        """Refresh container list."""
        self.refresh_containers()
        self.notify("Container list refreshed", severity="information")
    
    def action_quit(self) -> None:
        """Quit the application."""
        self.app.exit()


class MainMenuScreen(Screen):
    """Main menu screen with Monitor and Create options."""
    
    def compose(self) -> ComposeResult:
        yield Header()
        
        with Container(id="menu-container"):
            yield Static("Docker Mass Deployment Manager", classes="title")
            yield Static("Choose an option:", classes="subtitle")
            
            with Vertical(id="menu-buttons"):
                yield Button("Monitor Containers", id="monitor", variant="primary")
                yield Button("Create Containers", id="create", variant="success")
                yield Button("Quit", id="quit", variant="error")
        
        yield Footer()
    
    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle menu button presses."""
        if event.button.id == "monitor":
            self.app.push_screen(MonitorScreen())
        elif event.button.id == "create":
            self.show_create_dialog()
        elif event.button.id == "quit":
            self.app.exit()
    
    async def show_create_dialog(self) -> None:
        """Show create container dialog."""
        result = await self.push_screen_wait(CreateContainerScreen())


class DockerManagerApp(App):
    """Main application class."""
    
    CSS = """
    #menu-container {
        align: center middle;
        width: 60;
        height: 20;
        background: $surface;
        border: thick $primary;
    }
    
    .title {
        text-align: center;
        text-style: bold;
        color: $primary;
        margin: 1 0;
    }
    
    .subtitle {
        text-align: center;
        margin: 1 0;
    }
    
    #menu-buttons {
        align: center middle;
        margin: 2 0;
    }
    
    #menu-buttons Button {
        width: 30;
        margin: 1 0;
    }
    
    #main-container {
        height: 100%;
    }
    
    #container-list {
        width: 2fr;
        margin: 1;
        border: solid $primary;
    }
    
    #actions-panel {
        width: 1fr;
        margin: 1;
        border: solid $primary;
    }
    
    .panel-title {
        text-align: center;
        text-style: bold;
        background: $primary;
        color: $text;
        margin-bottom: 1;
    }
    
    .section-title {
        text-style: bold;
        margin-top: 1;
        margin-bottom: 1;
    }
    
    #actions-panel Button {
        width: 100%;
        margin: 1 0;
    }
    
    #action-dialog, #create-dialog, #details-dialog {
        align: center middle;
        background: $surface;
        border: thick $primary;
        width: 80%;
        height: 80%;
        padding: 2;
    }
    
    #action-dialog {
        width: 50;
        height: 10;
    }
    
    #create-dialog Input {
        margin-bottom: 1;
    }
    
    #create-dialog Label {
        margin-top: 1;
        text-style: bold;
    }
    """
    
    TITLE = "Docker Mass Deployment Manager"
    
    def on_mount(self) -> None:
        """Called when the app starts."""
        self.push_screen(MainMenuScreen())


def main():
    """Main entry point for the GUI application."""
    app = DockerManagerApp()
    app.run()


if __name__ == "__main__":
    main()
