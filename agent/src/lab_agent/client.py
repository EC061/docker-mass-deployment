"""Agent runtime: dial the controller over WebSocket and pump tasks/results/logs.

Connection topology (agent-initiated, outbound only):

    agent --WSS--> controller
      send: hello, result, log, event, telemetry
      recv: task, ack

Durability: received tasks go into the local honker ``tasks`` queue before execution; outbound
frames go through the local honker ``outbox`` and are acked only after a successful send. So an
agent restart or a controller outage never drops work — buffered items flush on reconnect.
"""

from __future__ import annotations

import asyncio
import json
import ssl
import threading
from typing import Any

import websockets

from . import protocol as P
from . import usagereport
from .config import AgentConfig
from .dispatcher import Dispatcher
from .localq import LocalQueues
from .logbus import LogBus
from .system import detect_capabilities
from .usagereport import UsageState

INITIAL_BACKOFF = 1.0
MAX_BACKOFF = 30.0


class Agent:
    def __init__(self, cfg: AgentConfig):
        self.cfg = cfg
        self.localq = LocalQueues(cfg.state_db)
        self.log = LogBus(cfg.node_name, sink=self.localq.enqueue_outbound)
        self.dispatcher = Dispatcher(cfg, self.log)
        self.usage = UsageState()
        self._docker_lock = threading.Lock()  # single-flight guard for the docker-layer scan
        # On-demand usage scan (Stats page "Scan now"). Registered here rather than in the
        # dispatcher's builtins because it reuses the agent's shared scan cache + single-flight
        # lock, which live on the Agent, not the Dispatcher.
        self.dispatcher.register(P.A_USAGE_SCAN, self._handle_usage_scan)
        self._connected = asyncio.Event()

    # ------------------------------------------------------------------ helpers
    def _ssl_context(self):
        if not self.cfg.controller_url.startswith("wss://"):
            return None
        ctx = ssl.create_default_context()
        if not self.cfg.tls_verify:
            # The agent then sends AGENT_TOKEN over a link with no server authentication, so a MITM
            # can harvest the fleet token. Loudly flag it (L-08); prefer pinning a CA instead.
            self.log.warn(
                "client",
                "TLS verification is DISABLED (tls_verify=false): the controller is not "
                "authenticated and the agent token can be intercepted by a man-in-the-middle. "
                "Use a trusted/pinned CA instead for anything beyond a closed lab network.",
            )
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        return ctx

    # ------------------------------------------------------------------ runtime
    async def run(self) -> None:
        """Run forever: persistent task worker + GPU killer + reconnecting connection loop."""
        worker = asyncio.create_task(self._task_worker(), name="task-worker")
        gpu = asyncio.create_task(self._gpu_loop(), name="gpu-killer")
        publish = asyncio.create_task(self._usage_publish_loop(), name="usage-publish")
        lab_usage = asyncio.create_task(self._lab_usage_loop(), name="lab-usage")
        docker_scan = asyncio.create_task(self._docker_scan_loop(), name="docker-scan")
        pkg_update = asyncio.create_task(self._pkg_update_loop(), name="pkg-update")
        try:
            await self._connection_loop()
        finally:
            worker.cancel()
            gpu.cancel()
            publish.cancel()
            lab_usage.cancel()
            docker_scan.cancel()
            pkg_update.cancel()
            self.localq.close()

    async def _connection_loop(self) -> None:
        backoff = INITIAL_BACKOFF
        while True:
            try:
                async with websockets.connect(
                    self.cfg.controller_url,
                    ssl=self._ssl_context(),
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=8 * 1024 * 1024,
                ) as ws:
                    backoff = INITIAL_BACKOFF
                    await self._on_connected(ws)
            except asyncio.CancelledError:
                raise
            except websockets.exceptions.ConnectionClosed as exc:
                # The hub closes with a 40xx code + reason when it rejects our identity. Surface it
                # clearly so operators know to (re)provision rather than chase a network ghost.
                code = getattr(exc, "code", None)
                reason = getattr(exc, "reason", "") or ""
                if code in (4001, 4003):
                    self.log.error(
                        "client",
                        f"controller rejected this node (code {code}: {reason}). "
                        "Provision/rotate its token in the UI and run `lab-agent set-token`.",
                    )
                else:
                    self.log.warn("client", f"connection closed (code {code}: {reason})")
            except Exception as exc:  # connection refused/dropped/etc.
                self.log.warn("client", f"controller connection failed: {exc}")
            self._connected.clear()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF)

    async def _on_connected(self, ws) -> None:
        caps = detect_capabilities(self.cfg)
        await ws.send(json.dumps(P.hello_frame(self.cfg.node_name, self.cfg.token, caps.to_dict())))
        self._connected.set()
        self.log.info("client", f"connected to controller as node '{self.cfg.node_name}'")
        receiver = asyncio.create_task(self._receiver(ws), name="receiver")
        sender = asyncio.create_task(self._outbox_sender(ws), name="outbox-sender")
        heartbeat = asyncio.create_task(self._heartbeat(ws), name="heartbeat")
        done, pending = await asyncio.wait(
            {receiver, sender, heartbeat}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        # Surface the first exception (if any) so the connection loop logs + reconnects.
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, asyncio.CancelledError):
                raise exc

    async def _receiver(self, ws) -> None:
        async for raw in ws:
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                self.log.warn("client", "received non-JSON frame")
                continue
            if not isinstance(frame, dict):
                self.log.warn("client", "received non-object frame")
                continue
            if frame.get("type") == P.T_TASK:
                # A task frame must carry a string id + action; reject malformed pushes outright.
                if not isinstance(frame.get("id"), str) or not isinstance(frame.get("action"), str):
                    self.log.warn("client", "ignoring malformed task frame")
                    continue
                # Persist before executing -> at-least-once, then send a durable receipt so the
                # controller knows we hold it (the receipt rides the reliable outbox).
                self.localq.enqueue_task(frame)
                self.localq.enqueue_outbound(P.receipt_frame(frame["id"]))
            # Other inbound types (ack) are currently informational.

    async def _task_worker(self) -> None:
        """Claim tasks from the durable local queue and execute them off the event loop.

        Idempotent + dedup'd: a task whose id is already in the result journal (a redelivery after
        an ack loss or restart) is replayed from cache instead of re-executed.
        """
        while True:
            job = await asyncio.to_thread(self.localq.claim_task)
            if job is None:
                await asyncio.sleep(0.5)
                continue
            try:
                frame = self.localq.payload_of(job)  # decrypt the at-rest payload
                task = P.Task.from_frame(frame)
            except Exception as exc:
                # Undecodable/poison payload: drop it (acking) rather than loop on it forever.
                self.log.error("client", f"dropping undecodable task: {exc}")
                await asyncio.to_thread(job.ack)
                continue
            try:
                cached = await asyncio.to_thread(self.localq.cached_result, task.id)
                if cached is not None:
                    # Already executed this exact task — replay the cached result, do NOT re-run.
                    replay = {**cached, "cached": True}
                    self.localq.enqueue_outbound(replay)
                    await asyncio.to_thread(job.ack)
                    continue
                result = await asyncio.to_thread(self.dispatcher.handle, task)
                await asyncio.to_thread(self.localq.record_result, task.id, result)
                self.localq.enqueue_outbound(result)
                await asyncio.to_thread(job.ack)
            except Exception as exc:  # never let the worker die
                self.log.error("client", f"task worker error: {exc}")
                await asyncio.to_thread(job.retry, 30, str(exc))

    async def _outbox_sender(self, ws) -> None:
        """Drain the durable outbox over the connection; ack only after a successful send."""
        while True:
            job = await asyncio.to_thread(self.localq.claim_outbound)
            if job is None:
                await asyncio.sleep(0.25)
                continue
            try:
                frame = self.localq.payload_of(job)  # decrypt the at-rest payload before sending
                await ws.send(json.dumps(frame))
                await asyncio.to_thread(job.ack)
            except Exception:
                # Send failed (likely disconnect) -> return to queue, stop draining.
                await asyncio.to_thread(job.retry, 1, "send failed")
                raise

    async def _gpu_loop(self) -> None:
        """Persistent idle-GPU governor. Emits warn/kill events even while disconnected."""
        import time

        from .gpu import monitor
        from .gpu.killer import GpuKiller
        from .gpu.policy import get_policy

        killer = GpuKiller()
        while True:
            policy = get_policy()
            interval = max(5, policy.interval_s)
            if not policy.enabled:
                await asyncio.sleep(interval)
                continue
            try:
                procs = await asyncio.to_thread(monitor.list_gpu_processes)
                decisions = killer.evaluate(procs, policy, time.time())
                for d in decisions:
                    payload = {
                        "pid": d.pid,
                        "user": d.user,
                        "lab": d.lab,
                        "vram_bytes": d.proc.get("vram_bytes"),
                        "state": "killed" if d.action == "kill" else "warned",
                    }
                    if d.action == "kill":
                        # Re-verify the PID identity right before killing (M-06): if the original
                        # process already exited and the PID was recycled, skip the kill.
                        killed = await asyncio.to_thread(
                            monitor.kill_pid, d.pid, d.proc.get("start_time")
                        )
                        if not killed:
                            self.log.info("gpu", f"skipped kill of pid {d.pid}: process gone",
                                          lab=d.lab, user=d.user)
                            continue
                        self.log.warn("gpu", f"killed idle GPU pid {d.pid} (user={d.user})",
                                      lab=d.lab, user=d.user)
                    else:
                        self.log.warn("gpu", f"warned idle GPU pid {d.pid} (user={d.user})",
                                      lab=d.lab, user=d.user)
                    self.log.event("gpu", payload)
            except Exception as exc:  # never let the governor die
                self.log.error("gpu", f"gpu killer error: {exc}")
            await asyncio.sleep(interval)

    async def _heartbeat(self, ws) -> None:
        """Periodically emit a telemetry frame (pool free space, dataset usage, scrub, GPU)."""
        while True:
            try:
                from .telemetry import collect_heartbeat

                payload = await asyncio.to_thread(collect_heartbeat, self.cfg, self.usage)
            except Exception as exc:
                payload = {"error": str(exc)}
            self.log.telemetry(payload)
            await asyncio.sleep(self.cfg.heartbeat_interval_s)

    # ----------------------------------------------------------------- labquota usage report

    async def _usage_publish_loop(self) -> None:
        """Republish each lab's labquota usage snapshot from live ZFS metadata (cheap)."""
        while True:
            try:
                await asyncio.to_thread(self._publish_all_usage)
            except Exception as exc:  # never let the publisher die
                self.log.error("usage", f"usage publish error: {exc}")
            await asyncio.sleep(max(15, self.cfg.usage_publish_interval_s))

    async def _lab_usage_loop(self) -> None:
        """Recompute each lab's lab-level usage (fast/slow ZFS + container writable layer) on a
        fixed cadence and cache it; the heartbeat re-reports the cached snapshot. Moved off the
        per-15s heartbeat path so the agent does one ``zfs list`` / ``docker inspect`` per interval,
        not per heartbeat. The (expensive) per-student du breakdown is a separate, slower cache (see
        ``_docker_scan_loop``)."""
        while True:
            try:
                await asyncio.to_thread(self._refresh_lab_usage)
            except Exception as exc:  # never let the refresher die
                self.log.error("usage", f"lab usage refresh error: {exc}")
            await asyncio.sleep(max(30, self.cfg.lab_usage_interval_s))

    def _refresh_lab_usage(self) -> None:
        self.usage.replace_lab_level(usagereport.collect_lab_level(self.cfg, self.usage))

    def _publish_all_usage(self) -> None:
        # collect_zfs_usage returns a row per lab (lab-level fast), so it enumerates the labs; the
        # roster (provisioned scratch subdirs) is added per lab so a freshly-provisioned student is
        # listed even before any per-student ZFS/docker numbers exist.
        grouped = usagereport.collect_zfs_usage(self.cfg)
        for lab, lab_usage in grouped.items():
            try:
                usagereport.ensure_labquota_dirs(self.cfg, lab)
                roster = usagereport.list_lab_students(self.cfg, lab)
                snapshot = usagereport.build_snapshot(
                    self.cfg, lab, lab_usage, self.usage.docker_for(lab), roster=roster
                )
                usagereport.publish_snapshot(self.cfg, lab, snapshot)
            except Exception as exc:  # one bad lab must not stop the others
                self.log.warn("usage", f"publish failed for lab '{lab}': {exc}", lab=lab)

    async def _docker_scan_loop(self) -> None:
        """Refresh the (expensive) per-student du breakdown on a daily fallback cadence / on demand.

        A lab is (re)scanned when its cached data is older than ``docker_scan_interval_s`` (a daily
        safety net; the controller drives the precise nightly scan, by default at midnight), or when
        a student dropped a refresh marker and the cache is older than the forced floor (5 min). The
        container-level writable-layer total is NOT scanned here — it lives in the lab-level cache,
        refreshed on its own faster cadence (see ``_lab_usage_loop``).
        """
        floor_ms = 5 * 60 * 1000
        while True:
            try:
                # Single-flight: if the previous tick's scan is still running (a big lab can take a
                # while), skip this tick rather than piling concurrent scans on top of it.
                if self._docker_lock.acquire(blocking=False):
                    try:
                        await asyncio.to_thread(self._scan_due_docker, floor_ms)
                    finally:
                        self._docker_lock.release()
            except Exception as exc:  # never let the scanner die
                self.log.error("usage", f"docker scan loop error: {exc}")
            await asyncio.sleep(60)

    def _scan_due_docker(self, floor_ms: int) -> None:
        now = P.now_ms()
        interval_ms = max(60, self.cfg.docker_scan_interval_s) * 1000
        grouped = usagereport.collect_zfs_usage(self.cfg)
        for lab in grouped:
            cached = self.usage.docker_for(lab)
            age = None if cached.scanned_at is None else now - cached.scanned_at
            users_list = usagereport.list_lab_students(self.cfg, lab)
            requested = usagereport.newest_request(self.cfg, lab, users_list)
            due = age is None or age >= interval_ms
            # Honor a student request only if it is newer than the last scan (so one touch triggers
            # at most one scan) and the forced-refresh floor has elapsed (so a touch-loop cannot
            # make us scan more than once per floor).
            fresh_request = requested is not None and (
                cached.scanned_at is None or requested > cached.scanned_at
            )
            forced = fresh_request and (age is None or age >= floor_ms)
            if not (due or forced):
                continue
            self._scan_docker_lab(lab, users_list)

    def _scan_docker_lab(self, lab: str, usernames: list[str]) -> None:
        def progress(done: int, total: int, current: str) -> None:
            try:
                usagereport.write_status(
                    self.cfg,
                    lab,
                    {"status": "running", "done": done, "total": total,
                     "current": current, "ts": P.now_ms()},
                )
            except Exception:  # status is best-effort
                pass

        try:
            usagereport.ensure_labquota_dirs(self.cfg, lab)
            progress(0, len(usernames), "")
            usage = usagereport.run_docker_scan(self.cfg, lab, usernames, progress=progress)
            self.usage.set_docker(lab, usage)
            usagereport.clear_requests(self.cfg, lab, usernames)
            usagereport.write_status(
                self.cfg, lab, {"status": "idle", "scanned_at": usage.scanned_at}
            )
            # Republish immediately so the student sees fresh numbers without waiting a cycle.
            grouped = usagereport.collect_zfs_usage(self.cfg)
            roster = usagereport.list_lab_students(self.cfg, lab)
            snapshot = usagereport.build_snapshot(
                self.cfg, lab, grouped.get(lab, usagereport.LabUsage()), usage, roster=roster
            )
            usagereport.publish_snapshot(self.cfg, lab, snapshot)
        except Exception as exc:
            self.log.warn("usage", f"docker scan failed for lab '{lab}': {exc}", lab=lab)

    def _handle_usage_scan(self, cfg: AgentConfig, params: dict[str, Any]) -> tuple[Any, str]:
        """Controller-triggered usage scan for one lab (Stats page "Scan now").

        Refreshes **both** caches the Stats page reads so a single trigger updates the whole page:
        the lab-level totals (fast/slow ZFS + container writable layer) and the per-student ``du``
        breakdown. The per-student scan blocks on the same single-flight lock the background loop
        uses, so it never double-scans a container. The fresh numbers reach the controller on the
        next heartbeat; the returned ``scanned_at`` is the per-student freshness timestamp.
        """
        lab = params["lab"]
        users_list = params.get("users") or usagereport.list_lab_students(cfg, lab)
        with self._docker_lock:
            self._scan_docker_lab(lab, users_list)
        # Also recompute the lab-level snapshot now, so fast/cold/image refresh on the same trigger
        # rather than waiting for the next lab-usage cycle.
        try:
            self.usage.set_lab_level(lab, usagereport.lab_level_for(cfg, lab))
        except Exception as exc:  # lab-level refresh is best-effort; the per-student scan still ran
            self.log.warn("usage", f"lab-level refresh failed for '{lab}': {exc}", lab=lab)
        usage = self.usage.docker_for(lab)
        return {"lab": lab, "scanned_at": usage.scanned_at}, f"usage scan complete for '{lab}'"

    # ----------------------------------------------------------------- weekly in-container patching

    async def _pkg_update_loop(self) -> None:
        """Patch each lab's running container in place on a weekly cadence (apt update && upgrade).

        The due-check is timestamp-based and persisted to disk (see ``maintenance_state``), so the
        cadence is anacron-style: a window missed while the agent or node was down is caught up on
        the next wake, and the schedule survives restarts. Patching the running container's writable
        layer is what keeps the pinned base image frozen while security updates still land weekly.
        """
        while True:
            interval = max(300, self.cfg.apt_update_check_interval_s)
            if not self.cfg.apt_update_enabled:
                await asyncio.sleep(interval)
                continue
            try:
                await asyncio.to_thread(self._run_due_apt_upgrades)
            except Exception as exc:  # never let the loop die
                self.log.error("maintenance", f"package update loop error: {exc}")
            await asyncio.sleep(interval)

    def _run_due_apt_upgrades(self) -> None:
        from . import maintenance, maintenance_state

        for lab in usagereport.collect_zfs_usage(self.cfg):
            if not maintenance_state.is_due(self.cfg, lab, self.cfg.apt_update_interval_s):
                continue
            ok, note = maintenance.run_apt_upgrade(
                self.cfg, lab, timeout=self.cfg.apt_update_timeout_s
            )
            if ok:
                maintenance_state.record_apt_upgrade(self.cfg, lab)
                self.log.info("maintenance", note, lab=lab)
            else:
                self.log.warn("maintenance", note, lab=lab)


def run_agent(cfg: AgentConfig) -> None:
    asyncio.run(Agent(cfg).run())
