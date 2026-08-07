# HerdDeck — Stream Deck control for herdr agents (local + remote)

New repo `~/workspace/herddeck` (public, `gh repo create nickboy/herddeck --public`, SSH remote `git@github.com:`). Rebuilds ClaudeDeck's Stream Deck experience on herdr's socket API so one codebase controls **local and remote** agents of **any kind** (claude, codex, …), not just local Claude Code.

## Context

ClaudeDeck's complexity existed because Claude Code has no control API: it needed hooks + hook dispatch, a statusline patcher, PTY ring buffers, shell-PID resolution, AppleScript/TCC/codesign for jump-to-tab, and a project watcher. herdr replaces all of that with one Unix socket speaking NDJSON (`~/.config/herdr/herdr.sock`), agent lifecycle states built in (`idle/working/blocked/done/unknown`), and events push.

**Answer to the remote question:** yes — herdr's client/server split is exactly why this rebuild pays off, with one clarification. `herdr --remote` makes the *human* terminal experience thin-client (you already use it), but it does **not** expose a local API socket for the remote session — the local `herdr-client.sock` is the TUI attach endpoint, not an API proxy (verified: both sockets held by the local server process). So HerdDeck's daemon reaches a remote server via one `ssh -N -L <local>.sock:~/.config/herdr/herdr.sock host` forward — and then the **exact same daemon code** drives remote agents, because the remote server speaks the identical protocol. Version skew is mitigated but NOT eliminated: auto-sync only fires on a human `herdr --remote` attach — the daemon's ssh forward never triggers binary sync, so a rarely-attached remote can drift to an old protocol. Every target connection therefore `ping`s and compares protocol version; on mismatch the target degrades to a warning state (never assume parity). `herddeck doctor` checks the same.

## Verified facts (live on this machine, herdr 0.8.0, protocol 19, schema_version 1)

All previously-guessed API shapes confirmed via `herdr api schema --json` + live `herdr api snapshot`:

- `agent.focus` → `{target}`; `agent.send_keys` → `{target, keys: string[]}` (use this, not `pane.send_keys`, for answer keys); `agent.prompt` → `{target, text, wait?: {until?, timeout_ms?}}`; `agent.wait` → `{target, until?, timeout_ms?}`
- **`target` = unique live agent name OR pane id (`w1:p1`) — NOT terminal_id** (per `herdr --skill`)
- `events.subscribe` → `{subscriptions: [{type: "pane.agent_status_changed"}, ...]}`; event carries `{pane_id, agent_status}`. Also useful: `pane.created/closed`, `pane.agent_detected`, `workspace.*`, `worktree.*`, `pane.output_matched` (server-side regex watch!)
- `session.snapshot` → `{id, result: {snapshot: {agents[], panes[], layouts[], focused_*}}}`; `AgentInfo` has `pane_id`, `agent`, `name`, `agent_status`, `cwd`, `state_labels`, and a `tokens` string map (≤32 keys)
- `pane.report_metadata` → `{pane_id, source, tokens?, state_labels?, title?, ttl_ms?}` — writable metadata channel (context-donut path)
- `agent.explain` → `{target}` — herdr explains agent state; candidate for smart blocked-menu keys alongside `agent.read {target, source: "detection"}`
- `agent.read` sources: `visible | recent | recent_unwrapped | detection`
- `pane.output_matched` is a **parameterized subscription** (schema-verified): subscribe with `{type: "pane.output_matched", pane_id, source, match: {type: "substring"|"regex", value}, lines?, strip_ansi?}` — the server watches per-pane and pushes matches
- Injection-test cleanup methods exist: `pane.clear_agent_authority {pane_id, source?}` and `pane.release_agent {pane_id, source, agent}` (a `pane.report_agent` custom source becomes that pane's lifecycle authority until cleared)
- `worktree.create` → `{branch?, base?, path?, workspace_id?, focus?}`; `agent.start` → `{name, kind, pane_id}`
- Semantics: `done` = finished while tab unseen; focusing marks it seen (CLI reads do NOT). Perfect for "green until acknowledged" keys.
- `herdr status` reports client/server version + protocol + socket path — use in `herddeck doctor`.

**Operational rules (from ~/docs/herdr-setup.md, hard-won):**

- Daemon must NEVER auto-start a herdr server (env-leak incident) and NEVER call `server.stop`. Socket absent → target shows offline, nothing more.
- Reconnect must re-`session.snapshot` (handoff/upgrade drops subscription streams).
- Experiments run in a named test session (`herdr --session herddeck-test`), never against the main session.

## Architecture

```
Stream Deck plugin ──WebSocket──> Bun daemon (launchd)
                                    ├── SessionRegistry: target[] from config
                                    │     "local"   → ~/.config/herdr/herdr.sock
                                    │     "workbox" → ~/.herddeck/run/workbox.sock (ssh -N -L)
                                    ├── HerdrClient per target (NDJSON, req/resp corr., reconnect+re-snapshot,
                                    │     protocol-version ping check on connect)
                                    ├── StateCache keyed by (target, pane_id)
                                    └── TunnelManager (Phase 3; ssh keepalive/retry, offline = gray keys)
```

Forwarded sockets live in `~/.herddeck/run/` (dir mode 0700, permissions verified at startup) — never `/tmp`: anyone who can connect to that socket can send keys to remote panes, i.e. remote arbitrary command execution. TunnelManager unlinks any stale local socket file before spawning ssh (a leftover file makes `-L` bind fail).

**HerdrClient startup/reconnect ordering (race-free):** open the event connection and `events.subscribe` FIRST, buffering incoming events → then `session.snapshot` on the command connection → apply snapshot → replay buffered events, discarding any older than the snapshot via `AgentInfo.state_change_seq` / `PaneInfo.revision`. This prevents losing transitions that occur between snapshot and subscribe, and prevents StateCache regression.

Config `~/.herddeck/config.toml`: `[[targets]]` with `kind = "local" | "remote"`, `host`, `remote_socket`. Multi-target in the core from day 1; only local implemented until Phase 3.

**Dies vs ClaudeDeck** (herdr replaces): hookDispatch, claudeProjectWatcher, shellPidResolver, ptyRunner/ptyRingBuffer, statuslineAutoPatch (mostly), ghosttyFocus AppleScript (→ `agent.focus` + `open -a Ghostty`; no Accessibility/TCC/codesign).

**Ports nearly as-is** (own MIT code): `planUsagePoller` + `claudeAiFetcher` (OAuth/Keychain), `wisprFlowTrigger`, plugin `bridgeClient` + action structure + `sessionSlots` paging, `generateProfile`, `hooks/launchd`, Makefile/biome/CI/bun-test scaffolding.

## Repo layout

```
herddeck/
├── packages/protocol/   # schema.json (committed) + generated TS types + NDJSON codec
├── packages/daemon/     # HerdrClient, SessionRegistry, StateCache, TunnelManager, WS server
├── packages/plugin/     # com.nickboy.herddeck.sdPlugin (SDK v2)
├── packages/cli/        # herddeck: install / doctor / status / targets
├── profiles/  docs/plans/  install.sh  Makefile
```

Bun ≥1.2, TypeScript strict, Biome, bun test. Plugin↔daemon WS protocol adapted from ClaudeDeck.

## Phases

**Phase 0 — Bootstrap + live spike (half day).** `gh repo create`, scaffold monorepo, commit `herdr api schema --json` output as `packages/protocol/schema.json`. Run the spike against a named test session (`herdr --session herddeck-test`, `agent.start` a claude agent there). Verify: named-session socket path, `agent.send_keys` with `target` = pane id vs name, `agent.explain` response shape on a blocked agent, `events.subscribe` stream shape, `done`-marking behavior on `agent.focus`, and — decisive for the test strategy — that `pane.report_agent` with a custom source (e.g. `custom:herddeck-test`) on a plain shell pane injects arbitrary semantic states that show up in `agent.list` / status events as expected, **including cleanup**: confirm `pane.clear_agent_authority` (or `pane.release_agent`) returns the pane to a clean state afterwards. Also live-verify the `pane.output_matched` subscription (shape already schema-verified: per-pane `{pane_id, source, match: {type, value}}`) actually fires on menu-like output — this decides whether Phase 2's answer keys take the push path or the `agent.read` fallback.

**Phase 1 — protocol + daemon core (~1 wk).** Codegen types from schema.json; `HerdrClient` (framing, correlation ids, reconnect with the subscribe-first → snapshot → replay-buffer ordering above); `SessionRegistry` + `StateCache`; WS server; `herddeck status`. Subscription list includes `pane.moved`: a cross-workspace `pane.move` assigns a NEW public pane id with no close/create events, so StateCache must migrate its `(target, pane_id)` key on `pane.moved` or moved panes become zombie keys. *Accept:* status lists all agents with states; `herdr server stop`/restart of the **test** session → auto-recovery with no missed/regressed transitions (assert via seq numbers); deterministic state-machine tests drive working→blocked→done via `pane.report_agent` injection on a shell pane — zero tokens, millisecond-fast, no real agent needed. Test spec rule: every injection test cleans up in `afterEach` via `pane.clear_agent_authority`/`pane.release_agent` (or uses a fresh pane and `pane.close`s it) — a lingering custom source stays the pane's lifecycle authority and pollutes the next run.

**Phase 2 — plugin parity (~2 wks).** Actions: **Agent Slot** (name + status color: blocked red / working yellow / done green / idle gray; press → `agent.focus` + `open -a Ghostty`; paging via ported sessionSlots), **Answer keys** (YES/NO/ALWAYS → `agent.send_keys`; on blocked, render actual menu options per agent kind — primary path per the Phase 0 decision: `pane.output_matched` server-side subscriptions push menu matches instead of the daemon polling; fallback: `agent.read --source detection` + `agent.explain`), **arrows/enter**, **Plan Usage** + **Wispr Flow** (ports). Real agents appear here only in the hardware manual checklist. *Accept:* full ClaudeDeck parity on local target.

**Phase 3 — remote (~1 wk, needs a reachable remote herdr host — work box).** `TunnelManager`: lazy `ssh -N -L` into `~/.herddeck/run/` (stale-socket unlink first), retry/keepalive, per-target offline state; Target Switcher key. Day-1 checks on the real box: sshd `AllowStreamLocalForwarding` permits unix-socket `-L` forwards (default allows; `StreamLocalBindUnlink` is irrelevant — it's for `-R` remote forwards); 1Password agent auth from launchd context via hardcoded `IdentityAgent ~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock` in the target's ssh config (launchd does NOT inherit `SSH_AUTH_SOCK`). *Accept:* mixed local+remote slots; network drop → gray keys → auto-recover; protocol mismatch → warning state, not silent wrong behavior.

**Phase 4 — herdr-native extras (~1 wk).** Worktree key (`worktree.create` + `agent.start`), canned-prompt keys (`agent.prompt` with `wait` → key turns yellow until settled), `pane.report_metadata` badge ("⛨ deck") visible in herdr sidebar.

**Phase 5 — polish + context donut.** install.sh + launchd (no Accessibility perms needed), `herddeck doctor` (checks `herdr status`, per-target protocol match, `~/.herddeck/run/` perms, tunnels), docs. Context donut: Claude statusline script writes token % via `pane.report_metadata` — daemon just reads `AgentInfo.tokens`. Details: the statusline script uses herdr-injected `HERDR_PANE_ID` + `HERDR_SOCKET_PATH` env vars directly; this design is remote-free-of-charge (statusline runs on the remote, writes the remote herdr, daemon reads through the tunnel — zero extra engineering); token metadata does NOT survive a server restart, but the statusline re-reports every turn so it self-heals; limits (80-char values, 16 keys per report) are far above the single `ctx_pct` key needed. Optional: herdr marketplace companion plugin.

## Model delegation (Claude Code subagents / sessions)

- **haiku:** schema→TS codegen, config.toml parser, key SVGs/state colors, NDJSON-framing unit tests, README/docs drafts.
- **sonnet:** HerdrClient port + reconnect logic, TunnelManager, plugin action adaptation from ClaudeDeck, StateCache event handling, planUsage/wispr ports.
- **strongest model:** blocked-menu detection + per-agent-kind key mapping, multi-target UX, protocol-version compatibility policy (pre-1.0 drift: record schema version, `ping` on connect, ignore unknown fields).

## Verification

- `bun test` per package (framing, cache transitions incl. `pane.moved` key migration, config); CI mirrors ClaudeDeck's.
- Deterministic integration tests: in the `herddeck-test` session, inject working→blocked→done via `pane.report_agent` (custom source) on a plain shell pane and assert StateCache + key renders — no real agent, no tokens (contingent on the Phase 0 injection check).
- Live: `herddeck status` vs `herdr api snapshot` diff; kill test server mid-stream → subscribe-first reconnect + re-snapshot observed, no state regression (seq-checked).
- Hardware: manual checklist per action on the Stream Deck MK.2 (press-through to a real blocked Claude prompt) — the only place real agents are required.
- Never touch the main herdr session in tests; never auto-start/stop servers from the daemon.
