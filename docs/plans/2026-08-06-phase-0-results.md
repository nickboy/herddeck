# Phase 0 Results — Live API Spike

Run 2026-08-06 against herdr 0.8.0 (protocol 19, schema_version 1) on a
named test session (`herdr --session herddeck-test server`, headless,
started with `env -i` to avoid env leaks). Spike:
`packages/protocol/spike/phase0.ts`. The default session was never
touched.

## Connection model (biggest finding — reshapes HerdrClient)

The API socket is **one request per connection**. The server answers the
first NDJSON line, ignores everything after it, and closes. Verified:
`ping` + `session.snapshot` on one connection → only `ping` answered,
and the second request never appears in the server log.

- **Commands**: open a fresh connection per call. Cheap on unix
  sockets; a small connection pool is optional, multiplexing is not
  possible.
- **`events.subscribe`**: converts its connection into a long-lived
  event stream. ACK: `{"result":{"type":"subscription_started"}}`. The
  subscription set is **fixed at open** — changing it means opening a
  new stream and closing the old one (make-before-break, dedupe by
  `state_change_seq`/`revision`).
- The plan's "subscribe first → snapshot → replay buffer" ordering
  survives unchanged; it just spans two connections.

## Subscriptions

- `pane.agent_status_changed`, `pane.output_matched`,
  `pane.scroll_changed` are **per-pane** (`pane_id` required; `"*"` →
  `pane_not_found`). Lifecycle events (`pane.created/closed/moved`,
  `pane.agent_detected`, `workspace.*`, `tab.*`, `worktree.*`) are
  global.
- One invalid subscription fails the whole batch with a derived-id
  error (`<reqid>:sub:<idx>:probe`) and **no ACK** for the rest.
- Consequence for StateCache: keep one global lifecycle stream; keep a
  second stream with per-pane subs, reopened whenever the pane set
  changes.

## Wire shapes

- Responses: `{id, result: {...}}` / `{id, error: {code, message}}`.
  Malformed requests come back with `id: ""` — correlation must
  tolerate unknown/empty ids. Server errors are typed codes
  (`pane_not_found`, `agent_not_ready`, `invalid_request`, …).
- Events: `{event: "<name>", data: {...}}`. NOTE the naming split:
  status/match events use dotted names (`pane.agent_status_changed`,
  `pane.output_matched`) but lifecycle events use underscores
  (`pane_created`) with `data.type` repeating the name.
- `ping` → `{type: "pong", version, protocol, capabilities:
  {live_handoff, detached_server_daemon}}` — exactly what the
  per-target version check needs.
- `workspace.create` → `{workspace, tab, root_pane}`; ids live in
  `workspace.workspace_id` (not `.id`), `tab.tab_id`,
  `root_pane.pane_id`.

## Verification checklist results

| Item | Result |
| --- | --- |
| Named-session socket path | ✅ `~/.config/herdr/sessions/<name>/herdr.sock` (`herdr session list --json` reports it; `HERDR_SOCKET_PATH` env var redirects the CLI) |
| `events.subscribe` stream shape | ✅ see above |
| `pane.output_matched` live fire | ✅ fires with `{matched_line, pane_id, read: {text, source, ...}}` — carries the matched content, no follow-up read needed |
| `pane.report_agent` injection | ✅ `{pane_id, source: "custom:herddeck-test", agent, state, seq}` → agent appears in `agent.list`, `pane.agent_status_changed` events fire per transition, `state_change_seq` increments |
| Injection cleanup | ⚠️ `pane.clear_agent_authority` returns ok but the agent record **persists** in `agent.list` (detection takes over and keeps a fallback-idle claude). **Reliable cleanup = close the pane/workspace** — tests should use a throwaway workspace per test and `workspace.close` it |
| `agent.send_keys` target forms | ⚠️ Both pane-id and name targets resolve, but **injected agents are rejected with `agent_not_ready`** ("not an active named agent") — it requires a real interactive-ready agent. `pane.send_keys` works regardless (verified keys landed via `agent.read`). Non-mutating agent calls (`agent.get`, `agent.explain`, `agent.read`, `agent.rename`) accept injected agents fine, by pane id or name |
| `agent.explain` shape | ✅ goldmine: returns every detection rule evaluated (id, priority, region, evidence incl. `region_preview`, matched), manifest source/version, fallback reason. Claude's blocked-menu rules (`bash_permission_prompt`, `generic_permission_prompt`, `live_blocked_form`, …) ship in herdr's remote manifests — Phase 2 can reuse herdr's own detection vocabulary instead of inventing menu parsing |
| `done` semantics | ⚠️ Not verifiable headlessly: with no attached client the sole pane counts as focused/seen, so injected `idle` stays `idle`. Re-verify with an attached client (or multi-workspace background pane) during Phase 2 hardware testing |
| `pane.moved` key migration | Not exercised (single-pane spike); subscription registered fine. Cover in Phase 1 unit tests + a two-workspace live test |

## Decisions locked for Phase 1

1. HerdrClient = per-call connections + reopenable event streams (no
   request multiplexing).
2. Answer keys drive real agents via `agent.send_keys`; the injected
   test path asserts state/events only, and uses `pane.send_keys` when
   it must type.
3. `pane.output_matched` is confirmed as the push path for blocked-menu
   detection; the event's embedded `read.text` means zero follow-up
   round-trips.
4. Integration tests: one throwaway workspace per test,
   `workspace.close` in teardown (not `clear_agent_authority`).
5. Codegen note: field names differ per entity (`workspace_id` /
   `tab_id` / `pane_id`) — generate from schema, do not hand-write.

## Open items carried to later phases

- `done`-state behavior with an attached client (Phase 2).
- `pane.moved` id-reassignment live test (Phase 1).
- Remote tunnel day-1 checks (Phase 3, needs the work box).

## Addendum — Phase 1 live-integration discoveries (2026-08-07)

- **Container closes don't emit pane events**: `workspace.close` /
  tab close emit only `workspace_closed` / `tab_closed` — no
  `pane_closed` for the panes inside. StateCache cascade-removes
  panes on the container event.
- **`workspace.close` completes asynchronously**: the ok response
  returns immediately; pane processes wind down for ~1-2s before the
  `workspace_closed` event fires.
- **New subscribers get synthetic replay**: an events.subscribe
  stream receives `pane_created` events for panes that already
  existed. Harmless under the subscribe-first-then-snapshot ordering
  (replay dedupe drops them), but explains "stale" creates on fresh
  streams.
- Kill/restart recovery verified live: online → offline (capped
  backoff) → online within one retry of the server returning.

## Addendum — token metadata has no push path (2026-08-08)

Verified live against herdr 0.8.0 (protocol 19) while chasing a
context donut frozen at a value nothing had written for days:

- **`pane.report_metadata` emits no event.** Reporting `ctx_pct` to an
  idle pane while subscribed to `pane.updated` produced zero events
  for that pane. There is no `pane.metadata_changed`.
- **`pane.agent_status_changed` carries only `{pane_id,
  agent_status}`** — no tokens.
- Therefore tokens reach a client **only** through `session.snapshot`.
  A daemon that snapshots once on connect shows a donut frozen at
  connect time forever, no matter how often the agent reports.
- **`pane.updated` is not a workaround.** It does carry `tokens`, but
  it fires on scroll offsets and status flicker (~25 events in 2.5s
  from one active pane) and — decisively — does not fire for a
  metadata report, so a pane whose context moved while idle is never
  announced.
- **`tokens` is merged newest-write-wins across sources.** Reporting
  `ctx_pct` from a new `source` overwrites a value left by a different
  source; observed `10` → `88` on the next snapshot. Stale metadata
  needs no `clear_agent_authority`-style cleanup.

Consequence: `TargetMonitor` re-reads the snapshot on a timer
(`tokensRefreshMs`, default 10s) and merges **tokens only** —
re-seeding would let a timer-fetched snapshot regress state that newer
pushed events already advanced.
