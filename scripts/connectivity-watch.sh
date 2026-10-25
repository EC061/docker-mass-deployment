#!/usr/bin/env bash
# Independent probes keep a controller connection failure from hiding its own evidence.
set -u
umask 077

usage() {
  cat <<'EOF'
Usage: connectivity-watch.sh [--controller] [--once]

Read-only connectivity recorder; defaults to 24 hours, one sample every 20 seconds.
--controller also probes the backend and TLS proxy over loopback.
--once records one sample and exits (including when probes fail).

Environment:
  CONTROLLER_HOST  lab.edwardcheng.net
  CONTROLLER_IP    150.136.85.210 (pin independently of DNS)
  BACKEND_URL      http://127.0.0.1:8443/login
  CONTROL_URL      https://example.com/ (independent Internet reachability)
  INTERVAL        20 seconds between samples
  DURATION        86400 seconds; a sample in progress may finish after this limit
  PROBE_TIMEOUT   5 seconds per request
  OUTPUT_DIR      /tmp/lab-connectivity-HOSTNAME-UTC_TIMESTAMP
EOF
}

controller=false
once=false
for arg in "$@"; do
  case "$arg" in
    --controller) controller=true ;;
    --once) once=true ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

CONTROLLER_HOST=${CONTROLLER_HOST:-lab.edwardcheng.net}
CONTROLLER_IP=${CONTROLLER_IP:-150.136.85.210}
BACKEND_URL=${BACKEND_URL:-http://127.0.0.1:8443/login}
CONTROL_URL=${CONTROL_URL:-https://example.com/}
INTERVAL=${INTERVAL:-20}
DURATION=${DURATION:-86400}
PROBE_TIMEOUT=${PROBE_TIMEOUT:-5}
for value in "$INTERVAL" "$DURATION" "$PROBE_TIMEOUT"; do
  if [[ ! "$value" =~ ^[1-9][0-9]{0,5}$ ]]; then
    echo 'INTERVAL, DURATION and PROBE_TIMEOUT must be positive integers <= 999999' >&2
    exit 2
  fi
done
for cmd in curl timeout date hostname; do
  command -v "$cmd" >/dev/null || { echo "Missing command: $cmd" >&2; exit 2; }
done

OUTPUT_DIR=${OUTPUT_DIR:-/tmp/lab-connectivity-$(hostname)-$(date -u +%Y%m%dT%H%M%SZ)}
# Refuse existing directories so another user cannot redirect privileged log writes.
mkdir -m 700 -- "$OUTPUT_DIR" || exit 2
echo "Recording to $OUTPUT_DIR for $DURATION seconds"
trap 'exit 0' INT TERM

probe() {
  local label=$1
  shift
  local result rc
  result=$(curl --silent --show-error --noproxy '*' --output /dev/null \
    --connect-timeout "$PROBE_TIMEOUT" --max-time "$PROBE_TIMEOUT" \
    --write-out 'http=%{http_code} remote=%{remote_ip} dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} first_byte=%{time_starttransfer} total=%{time_total}' \
    "$@" 2>&1)
  rc=$?
  printf '%s probe=%s rc=%s %s\n' "$(date -u +%FT%TZ)" "$label" "$rc" "$result"
  # curl considers HTTP errors successful unless checked explicitly.
  [[ "$rc" == 0 && "$result" == *'http=200 '* ]]
}

snapshot() {
  echo "$(date -u +%FT%TZ) failure_snapshot"
  uptime
  timeout "$PROBE_TIMEOUT" getent ahostsv4 "$CONTROLLER_HOST" || true
  timeout "$PROBE_TIMEOUT" ip route get "$CONTROLLER_IP" || true
  timeout "$PROBE_TIMEOUT" ss -tin dst "$CONTROLLER_IP" || true
  # No sudo prompts and no credentials/configuration dumps.
  if command -v sudo >/dev/null; then
    timeout "$PROBE_TIMEOUT" sudo -n journalctl -u lab-agent --since '-2 minutes' \
      -n 60 --no-pager 2>&1 || true
  fi
}

start=$SECONDS
while :; do
  logfile="$OUTPUT_DIR/$(date -u +%Y%m%dT%H).log"
  {
    echo "$(date -u +%FT%TZ) sample host=$(hostname)"
    failed=false
    probe public "https://$CONTROLLER_HOST/login" || failed=true
    probe pinned --resolve "$CONTROLLER_HOST:443:$CONTROLLER_IP" \
      "https://$CONTROLLER_HOST/login" || failed=true
    probe internet_control "$CONTROL_URL" || failed=true
    if "$controller"; then
      probe local_proxy --resolve "$CONTROLLER_HOST:443:127.0.0.1" \
        "https://$CONTROLLER_HOST/login" || failed=true
      probe local_backend -H "Host: $CONTROLLER_HOST" "$BACKEND_URL" || failed=true
    fi
    if "$failed"; then snapshot; fi
  } >> "$logfile" 2>&1
  if "$once" || (( SECONDS - start >= DURATION )); then break; fi
  remaining=$((DURATION - (SECONDS - start)))
  delay=$INTERVAL
  if (( remaining < delay )); then delay=$remaining; fi
  sleep "$delay"
  if (( SECONDS - start >= DURATION )); then break; fi
done
