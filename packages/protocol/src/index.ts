// Wire protocol for herdr's NDJSON socket API.
// Facts verified live in docs/plans/2026-08-06-phase-0-results.md:
// one request per connection; events.subscribe holds its connection
// open as a stream whose subscription set is fixed at open.

export const EXPECTED_PROTOCOL = 19;

export interface HerdrError {
  code: string;
  message: string;
}

export interface HerdrResponse {
  id: string;
  result?: Record<string, unknown>;
  error?: HerdrError;
}

export interface HerdrEventEnvelope {
  event: string;
  data: Record<string, unknown>;
}

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentInfo {
  terminal_id: string;
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent: string | null;
  name?: string | null;
  agent_status: AgentStatus;
  cwd?: string | null;
  foreground_cwd?: string | null;
  state_change_seq: number;
  revision: number;
  focused: boolean;
  tokens?: Record<string, string>;
  state_labels?: Record<string, string>;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
}

export interface PaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id?: string;
  agent?: string | null;
  agent_status: AgentStatus;
  revision: number;
  focused: boolean;
  cwd?: string | null;
}

export interface WorkspaceInfo {
  workspace_id: string;
  number: number;
  label?: string | null;
  focused: boolean;
  agent_status: AgentStatus;
  pane_count?: number;
  tab_count?: number;
  active_tab_id?: string;
}

export interface SessionSnapshot {
  version: string;
  protocol: number;
  workspaces: WorkspaceInfo[];
  tabs: unknown[];
  panes: PaneInfo[];
  layouts: unknown[];
  agents: AgentInfo[];
}

export interface PongResult {
  type: "pong";
  version: string;
  protocol: number;
  capabilities: Record<string, boolean>;
}

export interface AgentStatusChangedData {
  pane_id: string;
  workspace_id?: string;
  agent?: string | null;
  agent_status: AgentStatus | null;
}

export interface OutputMatchedData {
  pane_id: string;
  matched_line: string;
  read: { text: string; source: string; pane_id: string };
}

export type Subscription =
  | { type: string }
  | { type: "pane.agent_status_changed"; pane_id: string }
  | {
      type: "pane.output_matched";
      pane_id: string;
      source: string;
      match: { type: "substring" | "regex"; value: string };
      lines?: number;
      strip_ansi?: boolean;
    };

export function encodeRequest(id: string, method: string, params: unknown = {}): string {
  return `${JSON.stringify({ id, method, params })}\n`;
}

export class LineDecoder {
  private buf = "";

  /** Feed a chunk; returns each complete NDJSON line parsed. */
  push(chunk: string): unknown[] {
    this.buf += chunk;
    const out: unknown[] = [];
    for (let idx = this.buf.indexOf("\n"); idx >= 0; idx = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.trim().length > 0) out.push(JSON.parse(line));
    }
    return out;
  }
}
