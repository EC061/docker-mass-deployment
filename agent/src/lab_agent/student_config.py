"""Student-owned tool configuration snippets shared by provisioning paths."""

from __future__ import annotations

CODEX_CONFIG_PATCH = r"""
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.parent.mkdir(parents=True, exist_ok=True)
text = path.read_text(encoding="utf-8") if path.exists() else ""
lines = text.splitlines()
out = []
in_features = False
features_seen = False
key_seen = False
inserted = False

for line in lines:
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        if in_features and not key_seen:
            out.append("use_legacy_landlock = true")
            inserted = True
        in_features = stripped == "[features]"
        features_seen = features_seen or in_features
        key_seen = False if in_features else key_seen
    if in_features and stripped.startswith("use_legacy_landlock"):
        out.append("use_legacy_landlock = true")
        key_seen = True
        continue
    out.append(line)

if in_features and not key_seen and not inserted:
    out.append("use_legacy_landlock = true")
elif not features_seen:
    if out and out[-1].strip():
        out.append("")
    out.extend(["[features]", "use_legacy_landlock = true"])

path.write_text("\n".join(out) + "\n", encoding="utf-8")
"""


def codex_config_patch_shell(path_expr: str) -> str:
    """Return shell that patches a Codex config path expression.

    ``path_expr`` is intentionally a shell expression so callers can pass paths containing their own
    variables, e.g. ``"$home/.codex/config.toml"``.
    """
    return "python3 - " + path_expr + " <<'PY'\n" + CODEX_CONFIG_PATCH + "PY\n"
