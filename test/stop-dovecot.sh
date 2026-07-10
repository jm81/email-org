#!/bin/bash
HERE="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$HERE/tmp/run/master.pid"
if [ -f "$PIDFILE" ]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
  sleep 0.5
fi
