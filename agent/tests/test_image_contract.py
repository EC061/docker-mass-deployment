from pathlib import Path


def test_lab_image_has_codex_bubblewrap_and_no_nested_engine():
    dockerfile = (Path(__file__).parents[2] / "image" / "Dockerfile").read_text()
    assert "ARG CODEX_VERSION=0.142.4" in dockerfile
    assert "setup_24.x" in dockerfile
    assert "bubblewrap uidmap libseccomp2" in dockerfile
    assert "chmod 0755 /usr/bin/bwrap" in dockerfile
    assert "test ! -u /usr/bin/bwrap" in dockerfile
    for package in ("docker-ce", "docker.io", "containerd.io", "nvidia-container-toolkit"):
        assert package not in dockerfile
