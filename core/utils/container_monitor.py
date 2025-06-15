import subprocess
import json
from typing import List, Dict, Optional


def get_container_list() -> List[Dict]:
    """Get list of all Docker containers created by this program."""
    try:
        # Get all containers (running and stopped) with detailed info
        cmd = [
            "docker", "ps", "-a", 
            "--format", "json"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        
        containers = []
        for line in result.stdout.strip().split('\n'):
            if line:
                container_info = json.loads(line)
                # Filter containers that match our naming pattern (team_* or manual_*)
                name = container_info.get('Names', '')
                if name.startswith('team_') or name.startswith('manual_'):
                    containers.append({
                        'id': container_info.get('ID', ''),
                        'name': name,
                        'image': container_info.get('Image', ''),
                        'status': container_info.get('Status', ''),
                        'state': container_info.get('State', ''),
                        'ports': container_info.get('Ports', ''),
                        'created': container_info.get('CreatedAt', ''),
                        'size': container_info.get('Size', '')
                    })
        
        return containers
    except subprocess.CalledProcessError as e:
        print(f"Error getting container list: {e}")
        return []
    except json.JSONDecodeError as e:
        print(f"Error parsing container info: {e}")
        return []


def get_container_details(container_id: str) -> Optional[Dict]:
    """Get detailed information about a specific container."""
    try:
        cmd = ["docker", "inspect", container_id]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        container_data = json.loads(result.stdout)[0]
        
        # Extract relevant information
        config = container_data.get('Config', {})
        network_settings = container_data.get('NetworkSettings', {})
        state = container_data.get('State', {})
        
        # Extract environment variables for usernames/passwords
        env_vars = config.get('Env', [])
        users = {}
        for env in env_vars:
            if env.startswith('USERNAME'):
                key = env.split('=')[0]
                value = env.split('=')[1] if '=' in env else ''
                users[key] = value
            elif env.startswith('PASSWORD'):
                key = env.split('=')[0]
                value = env.split('=')[1] if '=' in env else ''
                users[key] = value
        
        # Extract port mappings
        ports = network_settings.get('Ports', {})
        port_mappings = []
        for container_port, host_bindings in ports.items():
            if host_bindings:
                for binding in host_bindings:
                    port_mappings.append(f"{binding['HostPort']}:{container_port}")
        
        return {
            'id': container_data.get('Id', ''),
            'name': container_data.get('Name', '').lstrip('/'),
            'image': config.get('Image', ''),
            'status': state.get('Status', ''),
            'running': state.get('Running', False),
            'started_at': state.get('StartedAt', ''),
            'finished_at': state.get('FinishedAt', ''),
            'ports': port_mappings,
            'users': users,
            'restart_policy': container_data.get('HostConfig', {}).get('RestartPolicy', {}),
            'mounts': [mount['Source'] + ':' + mount['Destination'] for mount in container_data.get('Mounts', [])],
            'cpu_limit': container_data.get('HostConfig', {}).get('CpuQuota', 0),
            'memory_limit': container_data.get('HostConfig', {}).get('Memory', 0)
        }
    except subprocess.CalledProcessError as e:
        print(f"Error getting container details: {e}")
        return None
    except (json.JSONDecodeError, IndexError) as e:
        print(f"Error parsing container details: {e}")
        return None


def start_container(container_id: str) -> bool:
    """Start a stopped container."""
    try:
        cmd = ["docker", "start", container_id]
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"Error starting container: {e}")
        return False


def stop_container(container_id: str) -> bool:
    """Stop a running container."""
    try:
        cmd = ["docker", "stop", container_id]
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"Error stopping container: {e}")
        return False


def restart_container(container_id: str) -> bool:
    """Restart a container."""
    try:
        cmd = ["docker", "restart", container_id]
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"Error restarting container: {e}")
        return False


def delete_container(container_id: str, force: bool = False) -> bool:
    """Delete a container."""
    try:
        cmd = ["docker", "rm"]
        if force:
            cmd.append("-f")
        cmd.append(container_id)
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"Error deleting container: {e}")
        return False


def get_container_logs(container_id: str, lines: int = 50) -> str:
    """Get logs from a container."""
    try:
        cmd = ["docker", "logs", "--tail", str(lines), container_id]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return result.stdout
    except subprocess.CalledProcessError as e:
        return f"Error getting logs: {e}"


def get_container_stats(container_id: str) -> Optional[Dict]:
    """Get real-time stats for a container."""
    try:
        cmd = ["docker", "stats", "--no-stream", "--format", "json", container_id]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        if result.stdout.strip():
            return json.loads(result.stdout.strip())
        return None
    except subprocess.CalledProcessError as e:
        print(f"Error getting container stats: {e}")
        return None
    except json.JSONDecodeError as e:
        print(f"Error parsing container stats: {e}")
        return None
