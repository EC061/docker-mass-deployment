"""Agent-side backup: snapshot the local state DB and upload it to WebDAV.

The agent's state.db is only a cache/buffer (durable task queue + offline event buffer), but the
controller can still back it up to the same WebDAV target for completeness. Triggered by the
controller via the node.backup task, which passes the per-node WebDAV destination + credentials.

Uses only the stdlib (sqlite3 for a consistent snapshot, urllib for WebDAV) — no extra deps.
"""

from __future__ import annotations

import base64
import sqlite3
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .config import AgentConfig


def _snapshot(db_path: str) -> bytes:
    """Consistent online snapshot of a (possibly WAL) SQLite DB via the backup API."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        src = sqlite3.connect(db_path)
        dst = sqlite3.connect(tmp_path)
        with dst:
            src.backup(dst)
        src.close()
        dst.close()
        return Path(tmp_path).read_bytes()
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def _dav_request(method: str, url: str, user: str, password: str, data: bytes | None = None) -> int:
    req = urllib.request.Request(url, data=data, method=method)
    if user:
        token = base64.b64encode(f"{user}:{password}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
    if data is not None:
        req.add_header("Content-Type", "application/octet-stream")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code


def _put(url: str, user: str, password: str, data: bytes) -> None:
    # Best-effort MKCOL of the collection, then PUT the object.
    base = url.rsplit("/", 1)[0]
    _dav_request("MKCOL", base, user, password)
    status = _dav_request("PUT", url, user, password, data)
    if status not in (200, 201, 204):
        raise RuntimeError(f"WebDAV PUT failed: HTTP {status}")


def backup_state(cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
    """Dispatcher handler for node.backup."""
    dav = params.get("webdav") or {}
    url = dav.get("url", "").rstrip("/")
    if not url:
        raise RuntimeError("node.backup requires a webdav.url")
    user = dav.get("user", "")
    password = dav.get("pass", "")

    data = _snapshot(cfg.state_db)
    stamp = int(time.time() * 1000)
    _put(f"{url}/state-{stamp}.db", user, password, data)
    _put(f"{url}/state-latest.db", user, password, data)
    return {"node": cfg.node_name, "bytes": len(data)}, f"backed up state.db ({len(data)} bytes)"
