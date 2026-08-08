#!/bin/sh
# herddeck-report-ctx — report a context-window percentage to herdr so
# HerdDeck's Agent Slot donut can render it.
#
#   herddeck-report-ctx 60
#
# Exists so you do NOT have to adopt HerdDeck's own statusline. If you
# already have a statusline you like, keep it and add one line that
# hands this script the percentage it already computed:
#
#   herddeck-report-ctx "$PCT" &
#
# The write goes to the herdr server of whatever machine the agent runs
# on, via the HERDR_PANE_ID / HERDR_SOCKET_PATH environment variables
# herdr injects into every pane. That makes it remote-free-of-charge:
# the agent's own machine reports, and a HerdDeck daemon elsewhere
# reads the value back through the SSH tunnel already forwarding that
# socket.
#
# herdr's `tokens` map is a merged, newest-write-wins view across
# sources, so this overwrites any stale ctx_pct left behind by an
# earlier reporter — no cleanup needed. Metadata does not survive a
# herdr server restart, but a statusline re-reports every turn, so the
# donut self-heals within one turn.
#
# Must NEVER break the caller's prompt: no `set -e`, every failure path
# falls through to `exit 0`, and nothing is ever written to stdout.

PCT_RAW="${1:-}"

# Normalize to a rounded integer. A non-numeric or empty argument
# reports nothing rather than writing garbage into the donut.
PCT="$(printf '%s' "$PCT_RAW" | awk '{ if ($1 ~ /^[0-9]+(\.[0-9]+)?$/ && $1 <= 100) printf "%d", $1 + 0.5 }' 2>/dev/null)"

[ -n "$PCT" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0
[ -n "${HERDR_SOCKET_PATH:-}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# `nc -U` is not portable across the Linux hosts herdr runs on, so the
# NDJSON line goes out through one short python3 socket call instead
# (same framing as packages/protocol — see docs/CONTRACTS.md).
python3 -c '
import json, socket, sys, time

pane_id, socket_path, pct = sys.argv[1], sys.argv[2], sys.argv[3]
req = {
    "id": "herddeck-ctx-%d" % int(time.time() * 1000),
    "method": "pane.report_metadata",
    "params": {
        "pane_id": pane_id,
        "source": "herddeck-statusline",
        "tokens": {"ctx_pct": pct},
    },
}
try:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(1)
    s.connect(socket_path)
    s.sendall((json.dumps(req) + "\n").encode("utf-8"))
    s.close()
except Exception:
    pass
' "$HERDR_PANE_ID" "$HERDR_SOCKET_PATH" "$PCT" >/dev/null 2>&1

exit 0
