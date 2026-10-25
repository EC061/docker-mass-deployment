# Recording intermittent controller outages

Run `bash scripts/connectivity-watch.sh` on each affected node and on the controller host
(add `--controller` there). No packages, tokens, restarts, packet capture, or student file access
are required. Requires Bash, curl, GNU timeout, and standard Linux network tools. Each request
has a five-second limit; HTTP probes run sequentially and have their own UTC timestamps.

The recorder runs continuously and deletes expired log files as it samples. Minute-sized files
retain approximately the last 24 hours (up to one minute of extra history, plus one sampling
cycle). Expiration uses the last write time, including after service restarts. `RETENTION`
overrides the retention window in seconds. Only timestamped recorder logs are pruned.

For a temporary detached recording, first check `tmux ls`, then start a named session:

```bash
tmux new-session -d -s lab-connectivity \
  'bash /path/to/connectivity-watch.sh > /tmp/lab-connectivity-launch.log 2>&1'
```

On the controller use `--controller`. The launcher log prints the output directory. To stop:
`tmux kill-session -t lab-connectivity`. Use `DURATION=3600` for a one-hour run, or `--once` for
a quick check. `DURATION=0` (the default) has no time limit. Existing output directories must
be owned by the recorder's user, have mode 0700, and must not be symlinks. An exclusive lock
prevents two recorders writing the same directory.

For continuous recording across reboots, install the systemd service on each host:

```bash
sudo install -d -m 755 /usr/local/lib/lab-connectivity
sudo install -m 644 scripts/connectivity-watch.sh /usr/local/lib/lab-connectivity/
sudo install -m 644 scripts/lab-connectivity.service /etc/systemd/system/
# On the controller only (create this dedicated configuration file):
echo 'CONTROLLER_MODE=1' | sudo tee /etc/default/lab-connectivity
sudo systemctl daemon-reload
sudo systemctl enable --now lab-connectivity
```

The service writes private logs under `/var/lib/lab-connectivity/`, restarts on failure, and
starts at boot. It runs as root to read the agent journal, with filesystem writes restricted to
its state directory. It does not restart or change the controller, agents, or labs. Stop it with
`sudo systemctl disable --now lab-connectivity`. Inspect it with
`sudo systemctl status lab-connectivity --no-pager` and
`sudo journalctl -u lab-connectivity -n 30 --no-pager`.

Copy logs outside the recorder directory before investigating an incident if they must survive
the retention window. Stopping the recorder suspends pruning; startup removes expired files.

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
