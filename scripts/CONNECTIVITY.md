# Recording intermittent controller outages

Run `bash scripts/connectivity-watch.sh` on each affected node and on the controller host
(add `--controller` there). No packages, tokens, restarts, packet capture, or student file access
are required. Requires Bash, curl, GNU timeout, and standard Linux network tools. Each request
has a five-second limit; HTTP probes run sequentially and have their own UTC timestamps.

For a detached 24-hour recording, first check `tmux ls`, then start a named session:

```bash
tmux new-session -d -s lab-connectivity \
  'bash /path/to/connectivity-watch.sh > /tmp/lab-connectivity-launch.log 2>&1'
```

On the controller use `--controller`. The launcher log prints the output directory. Recordings
use private directories and hourly files. They stop after 24 hours; logs remain for inspection.
Use `DURATION=172800` for 48 hours. To stop early: `tmux kill-session -t lab-connectivity`.
Run with `--once` for a quick check. Use a fresh `OUTPUT_DIR` for each invocation.

The default IP is the current controller IP. Override `CONTROLLER_IP` when that changes.
All requests bypass HTTP proxy environment variables and validate TLS certificates, including
the pinned-IP and loopback requests. The script does not change the agents' connections.

Compare the same UTC minute across hosts:

| Evidence | Likely location / next check |
| --- | --- |
| Public fails, pinned succeeds | DNS resolver/records; compare `getent` snapshot |
| Public and pinned fail, Internet control succeeds | Controller-specific route, firewall, or ingress |
| Both controller probes and Internet control fail only on nodes | Node/campus Internet path; inspect routes and TCP retransmits |
| Nodes fail but controller's public, local proxy and backend succeed | Path between campus and controller; ask network operators with UTC times |
| Controller's local proxy fails, backend succeeds | TLS listener, reverse proxy, WAF; inspect OpenResty logs |
| Local backend fails too | Controller process, event-loop stall, DB/storage or host pressure |
| HTTP probes pass while agent disconnects | WebSocket-specific handling or long-lived connection path; correlate agent journal and proxy access logs |

`rc=6` is DNS failure, `7` is connect failure, `28` is timeout, and `35`/`60` indicate TLS
problems. Timing fields separate DNS, TCP, TLS and time to first response byte; these are
cumulative seconds since the request began. `http=502/504` implicates an upstream failure.
Snapshots include TCP retransmission information (`ss -tin`) and the last two minutes of the
agent journal when passwordless sudo permits it. Missing optional tools are recorded as errors.

These probes narrow the failure to a layer; they do not prove which router dropped packets.
If a transport outage recurs, synchronized packet captures at both ends or provider/campus
network logs may be needed. Do not send agent tokens in diagnostic requests.
