// Per-target state cache keyed by pane_id. Pure and synchronous — no
// sockets, fully unit-testable.
//
// Event names on the wire are inconsistent (verified live): lifecycle
// pushes use underscores ("pane_created", with data.type repeating it)
// while status pushes use dots ("pane.agent_status_changed"). The cache
// accepts both spellings so callers don't have to normalize first.

import type { AgentStatus, HerdrEventEnvelope, SessionSnapshot } from "@herddeck/protocol";

export interface CachedAgent {
  paneId: string;
  workspaceId: string;
  tabId: string;
  name: string | null;
  agentKind: string | null;
  status: AgentStatus;
  cwd: string | null;
  title: string | null;
  tabLabel: string | null;
  tokens: Record<string, string>;
  /** herdr's own notion of the pane the user is looking at. */
  focused: boolean;
  stateChangeSeq: number;
  revision: number;
}

interface PaneEntry {
  paneId: string;
  workspaceId: string;
  tabId: string;
  cwd: string | null;
  revision: number;
  // Agent fields; hasAgent gates inclusion in agents().
  hasAgent: boolean;
  name: string | null;
  agentKind: string | null;
  status: AgentStatus;
  title: string | null;
  tokens: Record<string, string>;
  focused: boolean;
  stateChangeSeq: number;
}

const STATUS_ORDER: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
};

const VALID_STATUS = new Set<string>(["idle", "working", "blocked", "done", "unknown"]);

interface ApplyOpts {
  replay?: boolean;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sameTokens(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

/** Lifecycle data may be flat or nest the pane object; read both. */
function paneField(data: Record<string, unknown>, key: string): unknown {
  if (key in data) return data[key];
  const pane = data.pane;
  if (typeof pane === "object" && pane !== null && key in pane) {
    return (pane as Record<string, unknown>)[key];
  }
  return undefined;
}

export class StateCache {
  private panes = new Map<string, PaneEntry>();
  private workspaceLabels = new Map<string, string | null>();
  private tabLabels = new Map<string, string | null>();

  seedFromSnapshot(snap: SessionSnapshot): void {
    this.panes.clear();
    this.workspaceLabels.clear();
    this.tabLabels.clear();

    for (const ws of snap.workspaces) {
      this.workspaceLabels.set(ws.workspace_id, ws.label ?? null);
    }
    // snap.tabs is `unknown[]` on the wire (protocol doesn't pin its
    // shape yet) — narrow defensively, same as event payloads below.
    for (const t of snap.tabs) {
      if (typeof t !== "object" || t === null) continue;
      const rec = t as Record<string, unknown>;
      const id = asStr(rec.tab_id);
      if (!id) continue;
      this.tabLabels.set(id, asStr(rec.label));
    }
    for (const pane of snap.panes) {
      this.panes.set(pane.pane_id, {
        paneId: pane.pane_id,
        workspaceId: pane.workspace_id,
        tabId: pane.tab_id,
        cwd: pane.cwd ?? null,
        revision: pane.revision,
        hasAgent: false,
        name: null,
        agentKind: null,
        status: pane.agent_status,
        title: null,
        tokens: {},
        focused: pane.focused === true,
        stateChangeSeq: 0,
      });
    }
    for (const agent of snap.agents) {
      const entry = this.panes.get(agent.pane_id);
      if (!entry) continue;
      entry.hasAgent = true;
      entry.name = agent.name ?? null;
      entry.agentKind = agent.agent;
      entry.status = agent.agent_status;
      entry.cwd = agent.cwd ?? agent.foreground_cwd ?? entry.cwd;
      entry.title = agent.terminal_title_stripped ?? agent.terminal_title ?? null;
      entry.tokens = agent.tokens ?? {};
      entry.stateChangeSeq = agent.state_change_seq;
      entry.revision = Math.max(entry.revision, agent.revision);
    }
  }

  /**
   * Apply a pushed event. Returns true iff cached state changed.
   *
   * Staleness rule: snapshot entries carry state_change_seq/revision,
   * but pushed status events carry neither. A live event therefore
   * always wins (apply unconditionally, idempotently) EXCEPT during
   * replay-after-snapshot ({ replay: true }): the lifecycle stream is
   * opened BEFORE session.snapshot, so every buffered event is
   * either already reflected in the snapshot or strictly newer. On
   * replay we drop an event when the cached entry's seq/revision is
   * newer OR EQUAL to the event's (equal ⇒ the snapshot already
   * reflects it); events that carry no seq/revision at all are dropped
   * whenever the pane is already cached, and applied only when they
   * describe something the snapshot missed (e.g. a pane created after
   * the snapshot was taken).
   */
  applyEvent(e: HerdrEventEnvelope, opts: ApplyOpts = {}): boolean {
    const name = e.event.replaceAll(".", "_");
    const data = e.data ?? {};
    switch (name) {
      case "pane_created":
        return this.applyPaneCreated(data, opts);
      case "pane_closed":
        return this.applyPaneClosed(data);
      case "pane_moved":
        return this.applyPaneMoved(data, opts);
      case "pane_agent_detected":
        return this.applyAgentDetected(data, opts);
      case "pane_agent_status_changed":
        return this.applyStatusChanged(data, opts);
      case "pane_focused":
        return this.applyPaneFocused(data);
      case "workspace_created":
      case "workspace_renamed":
        return this.applyWorkspaceUpsert(data);
      case "workspace_closed":
        return this.applyContainerClosed(data, "workspaceId");
      case "tab_created":
      case "tab_renamed":
        return this.applyTabUpsert(data);
      case "tab_closed":
        return this.applyContainerClosed(data, "tabId");
      default:
        return false;
    }
  }

  /**
   * herdr focus moved. The event names exactly one pane, so focus is
   * set there and cleared everywhere else.
   *
   * Idempotent on purpose: `pane_focused` is chatty — a fresh
   * subscription replays it for existing panes, and ~20 arrived in 3.5s
   * on a busy session — so re-announcing the pane that is already
   * focused must return false and not wake the Stream Deck.
   */
  private applyPaneFocused(data: Record<string, unknown>): boolean {
    const paneId = asStr(paneField(data, "pane_id"));
    if (!paneId || !this.panes.has(paneId)) return false;
    let changed = false;
    for (const entry of this.panes.values()) {
      const next = entry.paneId === paneId;
      if (entry.focused !== next) {
        entry.focused = next;
        changed = true;
      }
    }
    return changed;
  }

  private applyWorkspaceUpsert(data: Record<string, unknown>): boolean {
    const ws = data.workspace;
    if (typeof ws !== "object" || ws === null) return false;
    const rec = ws as Record<string, unknown>;
    const id = asStr(rec.workspace_id);
    if (!id) return false;
    this.workspaceLabels.set(id, asStr(rec.label));
    // Label changes don't affect agents(); callers re-read labels lazily.
    return false;
  }

  /** tab.created / tab.renamed — data may nest the tab object under
   * `data.tab` or be flat, same tolerance as paneField(). */
  private applyTabUpsert(data: Record<string, unknown>): boolean {
    const tab = data.tab;
    const rec = typeof tab === "object" && tab !== null ? (tab as Record<string, unknown>) : data;
    const id = asStr(rec.tab_id);
    if (!id) return false;
    this.tabLabels.set(id, asStr(rec.label));
    // Label changes don't affect agents(); callers re-read labels lazily.
    return false;
  }

  /**
   * workspace.close / tab.close cascade-remove their panes WITHOUT
   * emitting pane_closed events (verified live) — remove them here.
   */
  private applyContainerClosed(
    data: Record<string, unknown>,
    field: "workspaceId" | "tabId",
  ): boolean {
    const container = (field === "workspaceId" ? data.workspace : data.tab) as
      | Record<string, unknown>
      | undefined;
    const id =
      asStr(data[field === "workspaceId" ? "workspace_id" : "tab_id"]) ??
      (container ? asStr(container[field === "workspaceId" ? "workspace_id" : "tab_id"]) : null);
    if (!id) return false;
    let changed = false;
    for (const [paneId, entry] of this.panes) {
      if (entry[field] === id) {
        this.panes.delete(paneId);
        changed = true;
      }
    }
    if (field === "workspaceId") this.workspaceLabels.delete(id);
    if (field === "tabId") this.tabLabels.delete(id);
    return changed;
  }

  private applyPaneCreated(data: Record<string, unknown>, opts: ApplyOpts): boolean {
    const paneId = asStr(paneField(data, "pane_id"));
    if (!paneId) return false;
    const revision = asNum(paneField(data, "revision"));
    const existing = this.panes.get(paneId);
    if (existing) {
      // Replay of a create the snapshot already has, or duplicate push.
      if (opts.replay) return false;
      if (revision !== null && revision > existing.revision) {
        existing.revision = revision;
      }
      return false;
    }
    this.panes.set(paneId, {
      paneId,
      workspaceId: asStr(paneField(data, "workspace_id")) ?? "",
      tabId: asStr(paneField(data, "tab_id")) ?? "",
      cwd: asStr(paneField(data, "cwd")),
      revision: revision ?? 0,
      hasAgent: false,
      name: null,
      agentKind: null,
      status: "unknown",
      title: null,
      tokens: {},
      // A newly created pane is not focused until herdr says so.
      focused: false,
      stateChangeSeq: 0,
    });
    return true;
  }

  private applyPaneClosed(data: Record<string, unknown>): boolean {
    const paneId = asStr(paneField(data, "pane_id"));
    if (!paneId) return false;
    return this.panes.delete(paneId);
  }

  /**
   * pane.moved assigns a NEW pane_id with no close/create events
   * (verified live) — migrate the cache key, preserving agent state.
   */
  private applyPaneMoved(data: Record<string, unknown>, opts: ApplyOpts): boolean {
    const oldId =
      asStr(data.previous_pane_id) ??
      asStr(data.old_pane_id) ??
      asStr(data.from_pane_id) ??
      asStr(data.source_pane_id);
    const newId = asStr(data.new_pane_id) ?? asStr(paneField(data, "pane_id"));
    if (!oldId || !newId || oldId === newId) return false;
    const entry = this.panes.get(oldId);
    if (!entry) {
      // Replayed move the snapshot already reflects (new id present).
      return false;
    }
    if (opts.replay && this.panes.has(newId)) {
      // Snapshot already knows the new id; keep its (fresher) entry.
      this.panes.delete(oldId);
      return true;
    }
    this.panes.delete(oldId);
    entry.paneId = newId;
    const ws = asStr(data.workspace_id);
    const tab = asStr(data.tab_id);
    if (ws) entry.workspaceId = ws;
    if (tab) entry.tabId = tab;
    this.panes.set(newId, entry);
    return true;
  }

  private applyAgentDetected(data: Record<string, unknown>, opts: ApplyOpts): boolean {
    const paneId = asStr(paneField(data, "pane_id"));
    if (!paneId) return false;
    const entry = this.panes.get(paneId);
    if (!entry) return false;
    const seq = asNum(data.state_change_seq) ?? asNum(data.seq);
    if (opts.replay && entry.hasAgent && seq !== null && seq <= entry.stateChangeSeq) {
      return false;
    }
    if (opts.replay && entry.hasAgent && seq === null) return false;

    let changed = false;
    const kind = asStr(data.agent);
    const agentName = asStr(data.name);
    const status = asStr(data.agent_status);
    if (!entry.hasAgent) {
      entry.hasAgent = true;
      changed = true;
    }
    if (kind !== null && entry.agentKind !== kind) {
      entry.agentKind = kind;
      changed = true;
    }
    if (agentName !== null && entry.name !== agentName) {
      entry.name = agentName;
      changed = true;
    }
    if (status !== null && VALID_STATUS.has(status) && entry.status !== status) {
      entry.status = status as AgentStatus;
      changed = true;
    }
    if (seq !== null && seq > entry.stateChangeSeq) {
      entry.stateChangeSeq = seq;
      changed = true;
    }
    return changed;
  }

  private applyStatusChanged(data: Record<string, unknown>, opts: ApplyOpts): boolean {
    const paneId = asStr(data.pane_id);
    if (!paneId) return false;
    const entry = this.panes.get(paneId);
    if (!entry) return false;
    // Status pushes carry no seq/revision; on replay the snapshot (taken
    // after the stream opened) already reflects them — drop.
    if (opts.replay) return false;

    let changed = false;
    const kind = asStr(data.agent);
    if (kind !== null) {
      if (!entry.hasAgent) {
        entry.hasAgent = true;
        changed = true;
      }
      if (entry.agentKind !== kind) {
        entry.agentKind = kind;
        changed = true;
      }
    }
    const raw = data.agent_status;
    const status: AgentStatus =
      typeof raw === "string" && VALID_STATUS.has(raw) ? (raw as AgentStatus) : "unknown";
    if (entry.status !== status) {
      entry.status = status;
      changed = true;
    }
    return changed;
  }

  /** Agent panes ordered blocked, working, done, idle, unknown; stable by paneId within a group. */
  /**
   * Refresh token maps (the context-window donut's `ctx_pct`) from a
   * freshly fetched snapshot. Returns true iff anything changed.
   *
   * This exists because token metadata has no push path: verified live
   * against herdr 0.8.0, `pane.report_metadata` emits NO event at all,
   * and `pane.agent_status_changed` carries only `{pane_id,
   * agent_status}`. Tokens therefore reach us only via
   * `session.snapshot` — so without a periodic re-read the donut is
   * frozen at whatever it was when the daemon connected, no matter how
   * often the agent's statusline reports.
   *
   * `pane.updated` does carry tokens and would be the push path, but it
   * is not a substitute: it fires on scroll offsets and status flicker
   * (~25 events in 2.5s from a single active pane) and, decisively, it
   * does NOT fire for a metadata report — so a pane whose context moved
   * while it sat idle would never be announced.
   *
   * Deliberately touches ONLY tokens. Everything else in the cache is
   * owned by the snapshot-then-replay ordering in TargetMonitor, and
   * re-seeding here would let a late snapshot regress state that newer
   * pushed events already advanced.
   */
  mergeTokensFromSnapshot(snap: SessionSnapshot): boolean {
    let changed = false;
    // Focus rides along: it DOES have a push path (pane_focused), but a
    // dropped event would otherwise leave keys routing to a pane the
    // user stopped looking at until the next focus change. Re-reading
    // it on the same timer makes that self-heal.
    for (const pane of snap.panes) {
      const entry = this.panes.get(pane.pane_id);
      if (!entry) continue;
      const next = pane.focused === true;
      if (entry.focused !== next) {
        entry.focused = next;
        changed = true;
      }
    }
    for (const agent of snap.agents) {
      const entry = this.panes.get(agent.pane_id);
      if (!entry) continue;
      const next = agent.tokens ?? {};
      if (sameTokens(entry.tokens, next)) continue;
      entry.tokens = next;
      changed = true;
    }
    return changed;
  }

  agents(): CachedAgent[] {
    const out: CachedAgent[] = [];
    for (const entry of this.panes.values()) {
      if (!entry.hasAgent) continue;
      out.push({
        paneId: entry.paneId,
        workspaceId: entry.workspaceId,
        tabId: entry.tabId,
        name: entry.name,
        agentKind: entry.agentKind,
        status: entry.status,
        cwd: entry.cwd,
        title: entry.title,
        tabLabel: this.tabLabels.get(entry.tabId) ?? null,
        tokens: { ...entry.tokens },
        focused: entry.focused,
        stateChangeSeq: entry.stateChangeSeq,
        revision: entry.revision,
      });
    }
    out.sort((a, b) => {
      const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (byStatus !== 0) return byStatus;
      return a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0;
    });
    return out;
  }

  /** Forget a pane the server says no longer exists (a subscribe
   * rejected it). Returns true when something was removed. */
  removePane(paneId: string): boolean {
    return this.panes.delete(paneId);
  }

  /** All live pane ids (sorted for a deterministic subscription set). */
  paneIds(): string[] {
    return [...this.panes.keys()].sort();
  }

  workspaceLabel(workspaceId: string): string | null {
    return this.workspaceLabels.get(workspaceId) ?? null;
  }

  tabLabel(tabId: string): string | null {
    return this.tabLabels.get(tabId) ?? null;
  }
}
