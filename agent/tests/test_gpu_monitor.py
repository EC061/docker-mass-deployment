from lab_agent.executors.base import CommandResult
from lab_agent.gpu import monitor


def test_list_gpu_processes_merges_vram_and_util(monkeypatch):
    def fake_run(args, **kwargs):
        argv = [str(a) for a in args]
        joined = " ".join(argv)
        if "--query-compute-apps" in joined:
            # pid, used_gpu_memory (MiB)
            return CommandResult(True, argv, 0, "1234, 2048\n5678, 512\n", "")
        if "pmon" in joined:
            return CommandResult(
                True,
                argv,
                0,
                "# gpu        pid  type    sm   mem   enc   dec   command\n"
                "    0       1234     C     0     3     -     -   python\n"
                "    0       5678     C    87    40     -     -   train\n",
                "",
            )
        # container/user resolution -> fail gracefully
        return CommandResult(False, argv, 1, "", "n/a")

    monkeypatch.setattr(monitor, "run", fake_run)
    # Avoid touching /proc and docker for resolution.
    monkeypatch.setattr(monitor, "_container_of", lambda pid: None)
    monkeypatch.setattr(monitor, "_student_user", lambda c, p: None)

    procs = {p["pid"]: p for p in monitor.list_gpu_processes()}
    assert procs[1234]["vram_bytes"] == 2048 * 1024 * 1024
    assert procs[1234]["util"] == 0.0  # idle: holding VRAM, 0% SM
    assert procs[5678]["util"] == 87.0


def test_list_gpu_processes_empty_without_nvidia(monkeypatch):
    monkeypatch.setattr(monitor, "run", lambda args, **kw: CommandResult(False, [], 127, "", "not found"))
    assert monitor.list_gpu_processes() == []


def test_kill_pid_skips_on_start_time_mismatch(monkeypatch):
    killed = {}
    monkeypatch.setattr(monitor, "pid_start_time", lambda pid: 9999)  # current != expected
    monkeypatch.setattr("os.kill", lambda pid, sig: killed.setdefault("hit", True))
    # expected_start_time differs from current -> must NOT kill (PID was recycled).
    assert monitor.kill_pid(4242, expected_start_time=1234) is False
    assert "hit" not in killed


def test_kill_pid_proceeds_on_start_time_match(monkeypatch):
    killed = {}
    monkeypatch.setattr(monitor, "pid_start_time", lambda pid: 1234)
    monkeypatch.setattr("os.kill", lambda pid, sig: killed.setdefault("pid", pid))
    assert monitor.kill_pid(4242, expected_start_time=1234) is True
    assert killed["pid"] == 4242
