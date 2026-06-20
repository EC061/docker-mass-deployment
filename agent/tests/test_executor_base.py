from lab_agent.executors.base import run


def test_run_success():
    res = run(["true"])
    assert res.ok
    assert res.returncode == 0


def test_run_nonzero_is_graceful():
    res = run(["false"])
    assert not res.ok
    assert res.returncode != 0


def test_run_missing_binary_is_graceful():
    res = run(["this-binary-does-not-exist-xyz"])
    assert not res.ok
    assert res.returncode == 127
    assert "not found" in res.stderr


def test_run_captures_output_in_logs():
    res = run(["sh", "-c", "echo hello; echo oops 1>&2; exit 3"])
    assert not res.ok
    assert "hello" in res.logs
    assert "oops" in res.logs
    assert res.cmdline.startswith("sh -c")
