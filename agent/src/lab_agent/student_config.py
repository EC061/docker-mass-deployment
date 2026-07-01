"""Student-owned tool configuration migrations used by host preparation."""

from __future__ import annotations

CODEX_CONFIG_CLEANUP = r"""
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
if not path.exists():
    raise SystemExit(0)

text = path.read_text(encoding="utf-8")
lines = text.splitlines()
out = []
in_features = False

for line in lines:
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        in_features = stripped == "[features]"
    if in_features and re.match(r"^use_legacy_landlock\s*=", stripped):
        continue
    out.append(line)

updated = "\n".join(out) + ("\n" if text.endswith("\n") else "")
if updated != text:
    path.write_text(updated, encoding="utf-8")
"""


def codex_config_cleanup_shell(path_expr: str) -> str:
    """Return shell that removes deprecated Codex settings from a config path expression.

    ``path_expr`` is intentionally a shell expression so callers can pass paths containing their own
    variables, e.g. ``"$home/.codex/config.toml"``.
    """
    return "python3 - " + path_expr + " <<'PY'\n" + CODEX_CONFIG_CLEANUP + "PY\n"
