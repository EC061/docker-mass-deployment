from pathlib import Path


def test_lab_image_has_cuda_bubblewrap_and_no_nested_engine():
    dockerfile = (Path(__file__).parents[2] / "image" / "Dockerfile").read_text()
    entrypoint = (Path(__file__).parents[2] / "image" / "entrypoint").read_text()
    assert "nvidia/cuda:13.3.0-devel-ubuntu24.04@sha256:" in dockerfile
    assert "bubblewrap" in dockerfile
    assert "build-essential cmake ninja-build pkg-config" in dockerfile
    assert "nvcc --version" in dockerfile
    assert "nvcc -c /tmp/cuda-smoke.cu" in dockerfile
    assert "chown root:root /usr/bin/bwrap" in dockerfile
    assert "chmod 4755 /usr/bin/bwrap" in dockerfile
    assert "test -u /usr/bin/bwrap" in dockerfile
    for forbidden in ("nodejs", "npm install", "@openai/codex", "CODEX_VERSION"):
        assert forbidden not in dockerfile
    assert "systemd" not in dockerfile
    assert "/sbin/init" not in dockerfile
    assert 'STOPSIGNAL SIGTERM' in dockerfile
    assert "ssh-keygen -A" in entrypoint
    assert "exec /usr/sbin/sshd -D -e" in entrypoint
    for package in ("docker-ce", "docker.io", "containerd.io", "nvidia-container-toolkit"):
        assert package not in dockerfile
