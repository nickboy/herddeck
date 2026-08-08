#!/bin/sh
# herddeck-statusline — Claude Code statusline delegate for HerdDeck's
# context donut (Phase 5, docs/plans/2026-08-06-master-plan.md).
#
# Two jobs, both best-effort:
#
#   1. Extract `.context_window.percentUsed` from the per-turn
#      statusline JSON on stdin and report it to herdr via
#      `pane.report_metadata`, so the daemon can read
#      `AgentInfo.tokens.ctx_pct` and light up the Stream Deck donut.
#      Only fires when herdr has injected HERDR_PANE_ID and
#      HERDR_SOCKET_PATH into the agent's environment. This design is
#      remote-free-of-charge: the script runs wherever the agent runs,
#      writes to *that* machine's herdr, and the daemon reads it back
#      through whatever tunnel is already forwarding that socket.
#      Metadata doesn't survive a herdr server restart, but this
#      script re-reports every turn, so it self-heals.
#
#      `nc -U` is not portable to every Linux herdr host, so the NDJSON
#      line is written with a single short python3 socket call instead
#      (mirrors the daemon's own NDJSON-over-unix-socket framing —
#      docs/CONTRACTS.md `packages/protocol`).
#
#   2. Pass through: Claude Code statusline chaining hands the
#      upstream/next command's rendered text on the input JSON's
#      `.display` field (mirrors the delegate pattern in
#      claudedeck-ref/cli/src/statusline.sh — never clobber a richer
#      statusline someone chained in front of this one). Echo
#      `.display` verbatim when present; print nothing otherwise.
#      herddeck never originates its own visible statusline text.
#
# Must NEVER break the prompt: everything here is best-effort. No
# `set -e`/`set -u` — a missing jq/python3, a malformed input, or an
# unreachable socket all fall through silently to `exit 0`.

INPUT="$(cat 2>/dev/null)"

# --- 1. extract percentUsed, report to herdr (best-effort, silent) ---

PCT=""
if command -v jq >/dev/null 2>&1; then
  PCT="$(printf '%s' "$INPUT" | jq -r '.context_window.percentUsed // empty' 2>/dev/null)"
elif command -v python3 >/dev/null 2>&1; then
  PCT="$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    pct = data.get("context_window", {}).get("percentUsed", "")
    if pct != "" and pct is not None:
        print(pct)
except Exception:
    pass
' 2>/dev/null)"
fi

# Normalize to a rounded integer string; stays empty if PCT wasn't a
# plain number, so we never report garbage as ctx_pct.
PCT_INT=""
if [ -n "$PCT" ]; then
  PCT_INT="$(printf '%s' "$PCT" | awk '{ if ($1 ~ /^[0-9]+(\.[0-9]+)?$/) printf "%d", $1 + 0.5 }' 2>/dev/null)"
fi

if [ -n "$PCT_INT" ] && [ -n "${HERDR_PANE_ID:-}" ] && [ -n "${HERDR_SOCKET_PATH:-}" ] \
  && command -v python3 >/dev/null 2>&1; then
  python3 -c '
import json, socket, sys, time

pane_id, socket_path, pct = sys.argv[1], sys.argv[2], sys.argv[3]
req = {
    "id": "herddeck-statusline-%d" % int(time.time() * 1000),
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
' "$HERDR_PANE_ID" "$HERDR_SOCKET_PATH" "$PCT_INT" >/dev/null 2>&1 &
fi

# --- 2. passthrough: echo .display verbatim if present, else nothing ---

DISPLAY_TEXT=""
if command -v jq >/dev/null 2>&1; then
  DISPLAY_TEXT="$(printf '%s' "$INPUT" | jq -r 'if has("display") and (.display != null) then .display else empty end' 2>/dev/null)"
elif command -v python3 >/dev/null 2>&1; then
  DISPLAY_TEXT="$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    value = data.get("display")
    if value is not None:
        print(value)
except Exception:
    pass
' 2>/dev/null)"
fi

# Only emit a line when there is upstream text — an unconditional
# printf would render a blank statusline row.
[ -n "$DISPLAY_TEXT" ] && printf '%s\n' "$DISPLAY_TEXT"
exit 0
