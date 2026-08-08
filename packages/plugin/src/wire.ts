/**
 * Daemon ↔ plugin WebSocket protocol (v2) — see
 * `docs/CONTRACTS.md` "Daemon ↔ plugin WebSocket protocol (v2)".
 *
 * Duplicated here rather than imported from `packages/daemon` so the
 * plugin package has zero dependency on daemon internals (same
 * reasoning as claudedeck's `plugin/src/bridgeClient.ts`, except
 * there the wire types were a loose `{ type: string }` bag — here we
 * keep the full discriminated unions so `bridgeClient.ts` and the
 * actions can be typed directly against the real wire shapes).
 */

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "offline";

export interface AgentSnapshot {
  target: string; // config target name
  paneId: string;
  name: string | null; // herdr agent name if set
  agentKind: string | null; // "claude" | "codex" | ...
  status: AgentStatus;
  workspaceLabel: string | null;
  cwd: string | null;
  title: string | null; // terminal_title_stripped
  tabLabel: string | null; // herdr tab label if set
  ctxPct: number | null; // AgentInfo.tokens.ctx_pct, parsed
  stateChangeSeq: number;
}

export type TargetKind = "local" | "remote";
export type TargetState = "connecting" | "online" | "offline" | "protocol-mismatch";

export interface TargetSnapshot {
  name: string;
  kind: TargetKind;
  state: TargetState;
  protocol: number | null;
}

/**
 * `weeklyOther` is a catch-all for any weekly bucket Anthropic
 * surfaces that we haven't explicitly mapped yet. Copied verbatim
 * from claudedeck `daemon/src/types.ts` (see `docs/CONTRACTS.md`:
 * "`plan:update` / `PlanUsageSnapshot` / `PlanMetric` are copied
 * verbatim from claudedeck").
 */
export type PlanMetricKey = "fiveHour" | "sevenDay" | "extraUsage" | "weeklyOther";

export interface PlanMetric {
  key: PlanMetricKey;
  /** Human label, e.g. "5h session". */
  label: string;
  /** 0–100. */
  percentUsed: number;
  /** Unix ms when the allowance resets, or null if not applicable. */
  resetAt: number | null;
  detail?: string;
}

export interface PlanUsageSnapshot {
  metrics: PlanMetric[];
  fetchedAt: number;
}

export type AnswerKind = "yes" | "no" | "always";

export type WsEvent =
  | { type: "daemon:ready"; version: string }
  | { type: "targets:update"; targets: TargetSnapshot[] }
  | { type: "agents:update"; agents: AgentSnapshot[] } // full list, daemon-ordered
  | { type: "plan:update"; snapshot: PlanUsageSnapshot } // claudedeck shape, unchanged
  | { type: "plan:error"; reason: string };

export type WsCommand =
  | { type: "agent:focus"; target: string; paneId: string } // herdr agent.focus + foreground terminal app (local targets only)
  | { type: "agent:answer"; target: string; paneId: string; kind: AnswerKind }
  | { type: "agent:keys"; target: string; paneId: string; keys: string[] } // raw pane.send_keys passthrough (arrows/enter)
  | { type: "worktree:create"; target: string; workspaceId?: string } // Phase 4
  | { type: "prompt:canned"; target: string; paneId: string; text: string } // Phase 4
  | { type: "wispr-flow:start" }
  | { type: "wispr-flow:stop" };
