# HerdDeck Internal Contracts

Single source of truth for module boundaries. Read together with
`docs/plans/2026-08-06-phase-0-results.md` (verified herdr wire facts)
and `docs/plans/2026-08-06-master-plan.md` (phases).

## Conventions (apply to every package)

- Bun ≥ 1.2, TypeScript strict, ESM, Biome. Tests colocated
  (`foo.ts` + `foo.test.ts`), run with `bun test`.
- Plain `git`, never `yadm`. No AI attribution in commits.
- Comments explain constraints the code can't show — no narration.
- `$HOME` never hardcoded; daemon state lives under `~/.herddeck/`.
- Never auto-start or stop a herdr server. Absent socket ⇒ target
  offline. Integration tests use session `herddeck-test` with one
  throwaway workspace per test, `workspace.close` in teardown.

## packages/protocol

Exports (from `packages/protocol/src/index.ts`):

```ts
// NDJSON framing
export class LineDecoder {
  /** Feed a chunk; returns zero or more complete parsed JSON lines. */
  push(chunk: string): unknown[];
}
export function encodeRequest(id: string, method: string, params: unknown): string; // one line + "\n"

// Wire envelopes
export interface HerdrResponse { id: string; result?: Record<string, unknown>; error?: { code: string; message: string } }
export interface HerdrEventEnvelope { event: string; data: Record<string, unknown> }

// Core domain types (hand-curated from schema.json — field names verified)
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export interface AgentInfo { terminal_id: string; pane_id: string; workspace_id: string; tab_id: string; agent: string | null; name?: string | null; agent_status: AgentStatus; cwd?: string | null; state_change_seq: number; revision: number; focused: boolean; tokens?: Record<string, string>; state_labels?: Record<string, string>; terminal_title_stripped?: string | null }
export interface PaneInfo { pane_id: string; workspace_id: string; tab_id: string; agent_status: AgentStatus; revision: number; focused: boolean; cwd?: string | null }
export interface WorkspaceInfo { workspace_id: string; number: number; label?: string | null; focused: boolean; agent_status: AgentStatus }
export interface SessionSnapshot { version: string; protocol: number; workspaces: WorkspaceInfo[]; tabs: unknown[]; panes: PaneInfo[]; layouts: unknown[]; agents: AgentInfo[] }
export interface PongResult { type: "pong"; version: string; protocol: number; capabilities: Record<string, boolean> }
export const EXPECTED_PROTOCOL = 19;
```

Also: `scripts/generate-types.ts` — best-effort codegen from
`schema.json` `$defs` into `src/generated.ts` (exported wholesale;
curated types above stay the stable import surface).

## packages/daemon layout

```text
src/paths.ts        # ~/.herddeck dirs (config.toml, run/, daemon.log); mkdir run/ with 0700
src/config.ts       # config load/parse (shape below)
src/herdr/client.ts # call() + EventStream (transport only)
src/herdr/monitor.ts# TargetMonitor: connect loop, snapshot+streams, emits normalized events
src/stateCache.ts   # per-target cache keyed by pane_id
src/registry.ts     # SessionRegistry: TargetMonitor per config target
src/tunnel.ts       # TunnelManager (Phase 3)
src/server.ts       # Bun.serve: WS + GET /health on 127.0.0.1:9137
src/planUsagePoller.ts, src/claudeAiFetcher.ts, src/wisprFlowTrigger.ts  # claudedeck ports
src/focus.ts        # open -a <terminal app> (config [ui].terminal_app, default "Ghostty")
src/index.ts        # wiring + graceful shutdown
```

### config.toml shape (`~/.herddeck/config.toml`)

```toml
[daemon]
port = 9137            # optional, default 9137

[ui]
terminal_app = "Ghostty"  # optional

[plan_usage]
enabled = true         # optional, default true

[[targets]]
name = "local"         # required, unique, [a-z0-9-]+
kind = "local"         # "local" | "remote"
socket = "~/.config/herdr/herdr.sock"   # optional; default for local
session = "name"       # optional named session → ~/.config/herdr/sessions/<name>/herdr.sock

[[targets]]
name = "workbox"
kind = "remote"
host = "workbox"                          # ssh destination (~/.ssh/config applies)
remote_socket = "~/.config/herdr/herdr.sock"  # path on the remote
```

Missing file ⇒ default single local target. Parse errors are fatal
with a clear message. `TargetConfig` discriminated union on `kind`.

### HerdrClient transport (herdr/client.ts)

One request per connection (verified). API:

```ts
export class HerdrClient {
  constructor(socketPath: string);
  call<T = Record<string, unknown>>(method: string, params?: unknown, timeoutMs?: number): Promise<T>; // throws HerdrApiError{code,message} on error envelope
  openStream(subscriptions: unknown[], onEvent: (e: HerdrEventEnvelope) => void, onClose: (err?: Error) => void): Promise<StreamHandle>; // resolves after subscription_started ACK
}
```

### TargetMonitor (herdr/monitor.ts)

Owns the connect lifecycle per target. Ordering (verified race-free):

1. `ping` → protocol check (`protocol !== EXPECTED_PROTOCOL` ⇒ state
   `protocol-mismatch`, still usable, warn).
2. Open **lifecycle stream** (pane.created/closed/moved,
   pane.agent_detected, workspace.* …), buffering events.
3. `session.snapshot` → seed StateCache.
4. Replay buffer, discarding events older than snapshot
   (`state_change_seq` / `revision`).
5. Open **per-pane stream** for all panes with
   `pane.agent_status_changed` subs; reopen (make-before-break) when
   the pane set changes.

Emits: `status` (connecting|online|offline|protocol-mismatch),
`agents-changed` (full AgentSnapshot list). Reconnect with capped
exponential backoff (1s→30s) on any stream close or ECONNREFUSED;
never spawns herdr.

### StateCache

Keyed by `pane_id`. Applies snapshot + events; drops stale events by
seq; migrates keys on `pane.moved` (new pane_id, no close/create).
Pure/synchronous — fully unit-testable without a server.

## Daemon ↔ plugin WebSocket protocol (v2)

Adapted from claudedeck `daemon/src/types.ts` (same envelope style,
JSON text frames). Agents are addressed by `{ target, paneId }`.

```ts
export interface AgentSnapshot {
  target: string;            // config target name
  paneId: string;
  name: string | null;       // herdr agent name if set
  agentKind: string | null;  // "claude" | "codex" | ...
  status: "idle" | "working" | "blocked" | "done" | "unknown" | "offline";
  workspaceLabel: string | null;
  cwd: string | null;
  title: string | null;      // terminal_title_stripped
  ctxPct: number | null;     // AgentInfo.tokens.ctx_pct, parsed
  stateChangeSeq: number;
}
export interface TargetSnapshot {
  name: string;
  kind: "local" | "remote";
  state: "connecting" | "online" | "offline" | "protocol-mismatch";
  protocol: number | null;
}

export type WsEvent =
  | { type: "daemon:ready"; version: string }
  | { type: "targets:update"; targets: TargetSnapshot[] }
  | { type: "agents:update"; agents: AgentSnapshot[] }   // full list, daemon-ordered
  | { type: "plan:update"; snapshot: PlanUsageSnapshot } // claudedeck shape, unchanged
  | { type: "plan:error"; reason: string };

export type WsCommand =
  | { type: "agent:focus"; target: string; paneId: string }   // herdr agent.focus + foreground terminal app (local targets only)
  | { type: "agent:answer"; target: string; paneId: string; kind: "yes" | "no" | "always" }
  | { type: "agent:keys"; target: string; paneId: string; keys: string[] }  // raw pane.send_keys passthrough (arrows/enter)
  | { type: "worktree:create"; target: string; workspaceId?: string }       // Phase 4
  | { type: "prompt:canned"; target: string; paneId: string; text: string } // Phase 4
  | { type: "wispr-flow:start" }
  | { type: "wispr-flow:stop" };
```

`agent:answer` mapping lives in the daemon (per `agentKind`; default
claude: yes→`["1","enter"]`? — verified live in Phase 2 against a real
blocked prompt; keep the table in one module `src/answerMap.ts`).
Sends via `agent.send_keys` (real agents), falling back to
`pane.send_keys` on `agent_not_ready`.

`plan:update` / `PlanUsageSnapshot` / `PlanMetric` are copied verbatim
from claudedeck (`~/workspace/claudedeck-ref/daemon/src/types.ts`).

## packages/plugin

Port of claudedeck plugin (`~/workspace/claudedeck-ref/plugin/`):
`bridgeClient.ts` (WS reconnect client) adapts to the v2 protocol;
`sessionSlots.ts` becomes `agentSlots.ts` (slot paging over
AgentSnapshot list, filter/order: blocked first, then working, done,
idle; stable within group). Actions (SDK v2, UUID prefix
`com.nickboy.herddeck`): `agent-slot`, `answer-yes/no/always`,
`arrow-up/down/enter`, `plan-usage`, `wispr-flow`, `worktree`,
`target-switcher` (Phase 3), `menu` (paging). Key rendering: SVG
string → `setImage` data URI, status colors blocked=#f38ba8
working=#f9e2af done=#a6e3a1 idle=#6c7086 offline=#45475a
(Catppuccin Mocha).

## packages/cli

`herddeck` bin: `status` (connect WS, print targets+agents table),
`doctor` (socket exists+perms, `herdr status` parse, protocol match,
port free/daemon health, launchd loaded, tunnel state), `install` /
`uninstall` (launchd plist ~/Library/LaunchAgents/com.nickboy.herddeck.daemon.plist
running `bun <repo>/packages/daemon/src/index.ts`; no .app bundle, no
Accessibility — that whole claudedeck complexity is obsolete).
