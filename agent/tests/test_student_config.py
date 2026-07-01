import subprocess
import sys

from lab_agent.student_config import CODEX_CONFIG_CLEANUP


def test_codex_config_cleanup_removes_only_deprecated_feature(tmp_path):
    config = tmp_path / "config.toml"
    config.write_text(
        'model = "gpt-5.5"\n\n[features]\nuse_legacy_landlock = true\nweb_search = true\n'
        '\n[projects."/work"]\ntrust_level = "trusted"\n',
        encoding="utf-8",
    )

    for _ in range(2):
        subprocess.run(
            [sys.executable, "-", str(config)],
            input=CODEX_CONFIG_CLEANUP,
            text=True,
            check=True,
        )

    assert config.read_text(encoding="utf-8") == (
        'model = "gpt-5.5"\n\n[features]\nweb_search = true\n'
        '\n[projects."/work"]\ntrust_level = "trusted"\n'
    )
