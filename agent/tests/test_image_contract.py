from pathlib import Path


def test_lab_image_has_cuda_bubblewrap_and_no_nested_engine():
    dockerfile = (Path(__file__).parents[2] / "image" / "Dockerfile").read_text()
    entrypoint = (Path(__file__).parents[2] / "image" / "entrypoint").read_text()
    assert "ubuntu:24.04@sha256:" in dockerfile
    assert "cuda-minimal-build-13-3=13.3.1-1" in dockerfile
    assert "CUDA_KEYRING_SHA256=" in dockerfile
    assert "ENV PATH=/usr/local/cuda/bin:${PATH}" in dockerfile
    assert "ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64" in dockerfile
    assert "bubblewrap" in dockerfile
    assert "python-is-python3" in dockerfile
    assert "build-essential cmake ninja-build pkg-config" in dockerfile
    assert "nvcc --version" in dockerfile
    assert "nvcc -c /tmp/cuda-smoke.cu" in dockerfile
    assert "/etc/environment" in dockerfile
    assert "/etc/profile.d/cuda.sh" in dockerfile
    assert "ln -s /usr/local/cuda/bin/nvcc /usr/local/bin/nvcc" in dockerfile
    assert "chown root:root /usr/bin/bwrap" in dockerfile
    assert "chmod 4755 /usr/bin/bwrap" in dockerfile
    assert "test -u /usr/bin/bwrap" in dockerfile
    for forbidden in ("nvidia/cuda:", "cuda-toolkit-13-3", "cuda-libraries-dev-13-3",
                      "nodejs", "npm install", "@openai/codex", "CODEX_VERSION"):
        assert forbidden not in dockerfile
    assert "systemd" not in dockerfile
    assert "/sbin/init" not in dockerfile
    assert 'STOPSIGNAL SIGTERM' in dockerfile
    assert "ssh-keygen -A" in entrypoint
    assert "exec /usr/sbin/sshd -D -e" in entrypoint
    for package in ("docker-ce", "docker.io", "containerd.io", "nvidia-container-toolkit"):
        assert package not in dockerfile
