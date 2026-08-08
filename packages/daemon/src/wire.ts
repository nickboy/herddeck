// Daemon ↔ plugin WebSocket protocol (v2). Canonical definition lives
// in docs/CONTRACTS.md; the plugin keeps its own copy (wire.ts there)
// so the packages stay decoupled.

import type { PlanUsageSnapshot } from "./planTypes";

export type SlotStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "offline";

export interface AgentSnapshot {
  target: string;
  paneId: string;
  name: string | null;
  agentKind: string | null;
  status: SlotStatus;
  workspaceLabel: string | null;
  cwd: string | null;
  title: string | null;
  ctxPct: number | null;
  stateChangeSeq: number;
}

export interface TargetSnapshot {
  name: string;
  kind: "local" | "remote";
  state: "connecting" | "online" | "offline" | "protocol-mismatch";
  protocol: number | null;
  /** Remote-tunnel failure classification (additive, optional — the
   * plugin tolerates unknown/absent fields). "auth": permanent
   * config/auth failure, no retry. "retrying": transient failure, the
   * daemon is retrying on backoff. null: tunnel established (or a
   * local target). */
  detail?: "auth" | "retrying" | null;
}

export type WsEvent =
  | { type: "daemon:ready"; version: string }
  | { type: "targets:update"; targets: TargetSnapshot[] }
  | { type: "agents:update"; agents: AgentSnapshot[] }
  | { type: "plan:update"; snapshot: PlanUsageSnapshot }
  | { type: "plan:error"; reason: string };

export type WsCommand =
  | { type: "agent:focus"; target: string; paneId: string }
  | { type: "agent:answer"; target: string; paneId: string; kind: "yes" | "no" | "always" }
  | { type: "agent:keys"; target: string; paneId: string; keys: string[] }
  | { type: "worktree:create"; target: string; workspaceId?: string }
  | { type: "prompt:canned"; target: string; paneId: string; text: string }
  | { type: "wispr-flow:start" }
  | { type: "wispr-flow:stop" };
