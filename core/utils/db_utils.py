import sqlite3
import os
import datetime

# DB_PATH changed to use os.path.join
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
DB_PATH = os.path.join(DATA_DIR, "containers.db")


def ensure_data_dir():
    """Ensure the data directory exists"""
    data_dir = os.path.dirname(DB_PATH)
    if not os.path.exists(data_dir):
        os.makedirs(data_dir)


def init_db():
    """Initialize the database and create tables if they don't exist"""
    ensure_data_dir()

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Create containers table with the correct column names matching the insert statement
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS containers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_name TEXT UNIQUE NOT NULL,
        username1 TEXT NOT NULL,
        password1 TEXT NOT NULL,
        username2 TEXT,
        password2 TEXT,
        username3 TEXT,
        password3 TEXT,
        port INTEGER UNIQUE NOT NULL,
        image_name TEXT NOT NULL,
        cpu_limit TEXT NOT NULL,
        ram_limit TEXT NOT NULL,
        storage_limit TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL,
        status TEXT NOT NULL,
        container_id TEXT,
        ip_address TEXT
    )
    """)

    conn.commit()
    conn.close()


def add_container(
    group_name,
    members,
    port,
    image_name,
    cpu_limit,
    ram_limit,
    storage_limit,
    container_id=None,
    status="created",
    ip_address=None,
):
    """Add a new container to the database

    Args:
        group_name: Name of the container group
        members: List of user dictionaries with 'username' and 'password' keys
        port: Port number for the container
        image_name: Docker image name
        cpu_limit: CPU limit for the container
        ram_limit: RAM limit for the container
        storage_limit: Storage limit for the container
        container_id: Docker container ID (optional)
        status: Container status (default: "created")
        ip_address: Container IP address (optional)
    """
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Extract user credentials from the list
    username1 = members[0]["username"] if len(members) > 0 else None
    password1 = members[0]["password"] if len(members) > 0 else None
    username2 = members[1]["username"] if len(members) > 1 else None
    password2 = members[1]["password"] if len(members) > 1 else None
    username3 = members[2]["username"] if len(members) > 2 else None
    password3 = members[2]["password"] if len(members) > 2 else None

    if username1 is None or password1 is None:
        # At least one user is required
        return False

    try:
        cursor.execute(
            """
        INSERT INTO containers (
            group_name, username1, password1, username2, password2, username3, password3,
            port, image_name, cpu_limit, ram_limit, storage_limit, created_at, status, 
            container_id, ip_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                group_name,
                username1,
                password1,
                username2,
                password2,
                username3,
                password3,
                port,
                image_name,
                cpu_limit,
                ram_limit,
                storage_limit,
                datetime.datetime.now(),
                status,
                container_id,
                ip_address,
            ),
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        # Handle duplicate group_name or port
        conn.rollback()
        return False
    finally:
        conn.close()


def get_container(group_name=None, username=None, port=None):
    """Get container information by group_name, username, or port"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    query = "SELECT * FROM containers WHERE 1=1"
    params = []

    if group_name:
        query += " AND group_name = ?"
        params.append(group_name)
    if username:
        query += " AND (username1 = ? OR username2 = ? OR username3 = ?)"
        params.extend([username, username, username])
    if port:
        query += " AND port = ?"
        params.append(port)

    cursor.execute(query, params)
    result = cursor.fetchall()
    conn.close()

    return result


def update_container_status(group_name, status, container_id=None):
    """Update container status and optionally the container ID"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    query = "UPDATE containers SET status = ?"
    params = [status]

    if container_id:
        query += ", container_id = ?"
        params.append(container_id)

    query += " WHERE group_name = ?"
    params.append(group_name)

    cursor.execute(query, params)
    conn.commit()
    conn.close()

    return cursor.rowcount > 0


def get_all_containers(status=None):
    """Get all containers, optionally filtered by status"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    query = "SELECT * FROM containers"
    params = []

    if status:
        query += " WHERE status = ?"
        params.append(status)

    cursor.execute(query, params)
    result = [dict(row) for row in cursor.fetchall()]
    conn.close()

    return result
