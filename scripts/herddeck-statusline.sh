#!/bin/sh
# herddeck-statusline — Claude Code statusline delegate for HerdDeck's
# context donut (Phase 5, docs/plans/2026-08-06-master-plan.md).
#
# Two jobs, both best-effort:
#
#   1. Extract `.context_window.used_percentage` from the per-turn
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

# --- 1. extract context-window %, report to herdr (best-effort, silent) ---
#
# Field name: Claude Code emits `.context_window.used_percentage`. An
# earlier revision of this script read `.percentUsed`, which does not
# exist — the extraction silently yielded nothing and the donut never
# lit up. `percentUsed` is kept only as a fallback so the script also
# works against any build that ever used it; `used_percentage` wins.

PCT=""
if command -v jq >/dev/null 2>&1; then
  PCT="$(printf '%s' "$INPUT" | jq -r '.context_window | (.used_percentage // .percentUsed // empty)' 2>/dev/null)"
elif command -v python3 >/dev/null 2>&1; then
  PCT="$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    cw = data.get("context_window") or {}
    pct = cw.get("used_percentage")
    if pct is None:
        pct = cw.get("percentUsed")
    if pct is not None and pct != "":
        print(pct)
except Exception:
    pass
' 2>/dev/null)"
fi

# The herdr write itself lives in herddeck-report-ctx (one
# implementation, shared with people who keep their own statusline and
# just add a call to it). Backgrounded so a hung socket can never stall
# the prompt; validation of PCT happens in there.
REPORTER="$(dirname "$0")/herddeck-report-ctx.sh"
if [ -n "$PCT" ] && [ -x "$REPORTER" ]; then
  "$REPORTER" "$PCT" >/dev/null 2>&1 &
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
