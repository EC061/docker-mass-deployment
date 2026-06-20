import sqlite3
from pathlib import Path

import pytest

from lab_agent import backup
from lab_agent.config import AgentConfig


def test_snapshot_produces_valid_sqlite(tmp_path: Path):
    src = tmp_path / "state.db"
    conn = sqlite3.connect(src)
    conn.execute("CREATE TABLE t (id INTEGER, v TEXT)")
    conn.execute("INSERT INTO t VALUES (1, 'hello')")
    conn.commit()
    conn.close()

    data = backup._snapshot(str(src))
    assert data[:16].startswith(b"SQLite format 3")

    # The snapshot is a usable DB with the same data.
    out = tmp_path / "copy.db"
    out.write_bytes(data)
    c = sqlite3.connect(out)
    assert c.execute("SELECT v FROM t WHERE id=1").fetchone()[0] == "hello"
    c.close()


def test_backup_state_requires_url(tmp_path: Path):
    cfg = AgentConfig(controller_url="ws://x", token="t", state_db=str(tmp_path / "s.db"))
    with pytest.raises(RuntimeError, match="webdav.url"):
        backup.backup_state(cfg, {"webdav": {}})


def test_backup_state_uploads(tmp_path: Path, monkeypatch):
    src = tmp_path / "state.db"
    sqlite3.connect(src).close()
    cfg = AgentConfig(controller_url="ws://x", token="t", node_name="gpu-1", state_db=str(src))

    puts: list[str] = []
    monkeypatch.setattr(backup, "_put", lambda url, u, p, d: puts.append(url))
    result, _logs = backup.backup_state(cfg, {"webdav": {"url": "https://dav/x/nodes/gpu-1", "user": "u", "pass": "p"}})
    assert result["node"] == "gpu-1"
    assert any(url.endswith("state-latest.db") for url in puts)
    assert any("state-" in url and url.endswith(".db") for url in puts)
