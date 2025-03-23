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

    # Create containers table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS containers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        container_name TEXT UNIQUE NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
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
    container_name,
    username,
    password,
    port,
    image_name,
    cpu_limit,
    ram_limit,
    storage_limit,
    container_id=None,
    status="created",
    ip_address=None,
):
    """Add a new container to the database"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    try:
        cursor.execute(
            """
        INSERT INTO containers (
            container_name, username, password, port, image_name, 
            cpu_limit, ram_limit, storage_limit, created_at, status, 
            container_id, ip_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                container_name,
                username,
                password,
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
        # Handle duplicate container_name or port
        conn.rollback()
        return False
    finally:
        conn.close()


def get_container(container_name=None, username=None, port=None):
    """Get container information by container_name, username, or port"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    query = "SELECT * FROM containers WHERE 1=1"
    params = []

    if container_name:
        query += " AND container_name = ?"
        params.append(container_name)
    if username:
        query += " AND username = ?"
        params.append(username)
    if port:
        query += " AND port = ?"
        params.append(port)

    cursor.execute(query, params)
    result = cursor.fetchall()
    conn.close()

    return result


def update_container_status(container_name, status, container_id=None):
    """Update container status and optionally the container ID"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    query = "UPDATE containers SET status = ?"
    params = [status]

    if container_id:
        query += ", container_id = ?"
        params.append(container_id)

    query += " WHERE container_name = ?"
    params.append(container_name)

    cursor.execute(query, params)
    conn.commit()
    conn.close()

    return cursor.rowcount > 0


def delete_container(container_name):
    """Delete a container from the database"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("DELETE FROM containers WHERE container_name = ?", (container_name,))
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


def get_next_available_port(start_port=50000):
    """Get the next available port starting from start_port"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("SELECT port FROM containers ORDER BY port")
    used_ports = [row[0] for row in cursor.fetchall()]
    conn.close()

    current_port = start_port
    while current_port in used_ports:
        current_port += 1

    return current_port
