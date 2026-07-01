"""Acceptance tests for a real prepared Linux lab; opt in with LAB_INTEGRATION_CONTAINER."""

import json
import os
import subprocess
import tempfile

import pytest

CONTAINER = os.environ.get("LAB_INTEGRATION_CONTAINER")
STUDENT = os.environ.get("LAB_INTEGRATION_USER")
PASSWORD = os.environ.get("LAB_INTEGRATION_PASSWORD")

pytestmark = pytest.mark.integration


def docker(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", *args], check=True, capture_output=True, text=True, timeout=120)


@pytest.fixture(scope="module", autouse=True)
def real_lab():
    if not CONTAINER or not STUDENT:
        pytest.skip("set LAB_INTEGRATION_CONTAINER and LAB_INTEGRATION_USER on a prepared Linux node")
    if os.uname().sysname != "Linux":
        pytest.skip("Linux-only integration test")


def student_exec(*argv: str) -> None:
    docker("exec", "-u", STUDENT, "-e", f"HOME=/home/{STUDENT}", "-e", f"USER={STUDENT}",
           "-e", f"LOGNAME={STUDENT}", CONTAINER, *argv)


def test_outer_boundary_and_mounts():
    config = json.loads(docker("inspect", CONTAINER).stdout)[0]
    host = config["HostConfig"]
    assert host["Privileged"] is False
    assert "SYS_ADMIN" not in (host.get("CapAdd") or [])
    assert all("unconfined" not in item for item in host.get("SecurityOpt") or [])
    destinations = {mount["Destination"] for mount in config["Mounts"]}
    assert destinations == {"/home", "/cold-storage", "/run/labquota"}
    assert docker("exec", CONTAINER, "cat", "/proc/1/comm").stdout.strip() == "sshd"
    docker("exec", CONTAINER, "/usr/sbin/sshd", "-t")
    keys = docker(
        "exec", CONTAINER, "ssh-keyscan", "-T", "5", "-t", "ed25519", "127.0.0.1"
    )
    assert "ssh-ed25519" in keys.stdout


def test_unprivileged_bubblewrap_and_codex():
    student_exec("bwrap", "--version")
    student_exec("unshare", "--user", "--map-root-user", "true")
    student_exec("codex", "--version")
    student_exec("codex", "sandbox", "--", "true")


def test_gpu_storage_and_quota_commands():
    student_exec("sh", "-c", "test -w /home/$USER && test -w /cold-storage/$USER")
    student_exec("nvidia-smi")
    student_exec("codex", "sandbox", "--", "nvidia-smi")
    student_exec("labquota", "--me")


def test_sudo_reaches_container_root_but_not_host_files():
    if not PASSWORD:
        pytest.skip("set LAB_INTEGRATION_PASSWORD to verify student sudo")
    with tempfile.NamedTemporaryFile(prefix="lab-host-sentinel-", delete=False) as sentinel:
        sentinel.write(b"host-safe")
        path = sentinel.name
    try:
        result = subprocess.run(
            ["docker", "exec", "-i", "-u", STUDENT, CONTAINER, "sudo", "-S", "sh", "-c",
             'id -u; printf changed > "$1"', "sh", path],
            input=PASSWORD + "\n", capture_output=True, text=True, timeout=60, check=True,
        )
        assert "0" in result.stdout.splitlines()
        assert open(path, "rb").read() == b"host-safe"
    finally:
        os.unlink(path)
