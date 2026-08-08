import { describe, expect, test } from "bun:test";
import type { AgentInfo, AgentStatus, PaneInfo, SessionSnapshot } from "@herddeck/protocol";
import { StateCache } from "./stateCache.ts";

function pane(paneId: string, extra: Partial<PaneInfo> = {}): PaneInfo {
  return {
    pane_id: paneId,
    workspace_id: "ws-1",
    tab_id: "tab-1",
    agent_status: "idle",
    revision: 1,
    focused: false,
    ...extra,
  };
}

function agent(
  paneId: string,
  status: AgentStatus,
  seq: number,
  extra: Partial<AgentInfo> = {},
): AgentInfo {
  return {
    terminal_id: `term-${paneId}`,
    pane_id: paneId,
    workspace_id: "ws-1",
    tab_id: "tab-1",
    agent: "claude",
    agent_status: status,
    state_change_seq: seq,
    revision: 1,
    focused: false,
    ...extra,
  };
}

function snapshot(panes: PaneInfo[], agents: AgentInfo[], tabs: unknown[] = []): SessionSnapshot {
  return {
    version: "0.8.0",
    protocol: 19,
    workspaces: [
      { workspace_id: "ws-1", number: 1, label: "main", focused: true, agent_status: "idle" },
      { workspace_id: "ws-2", number: 2, label: null, focused: false, agent_status: "idle" },
    ],
    tabs,
    panes,
    layouts: [],
    agents,
  };
}

describe("seedFromSnapshot", () => {
  test("seeds agents, panes, and workspace labels", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(
      snapshot(
        [pane("p1"), pane("p2")],
        [
          agent("p1", "working", 5, {
            name: "alpha",
            cwd: "/tmp/x",
            terminal_title_stripped: "claude — x",
            tokens: { ctx_pct: "42" },
          }),
        ],
      ),
    );

    expect(cache.paneIds()).toEqual(["p1", "p2"]);
    expect(cache.workspaceLabel("ws-1")).toBe("main");
    expect(cache.workspaceLabel("ws-2")).toBeNull();
    expect(cache.workspaceLabel("nope")).toBeNull();

    const agents = cache.agents();
    expect(agents).toHaveLength(1);
    const a = agents[0];
    expect(a).toMatchObject({
      paneId: "p1",
      workspaceId: "ws-1",
      tabId: "tab-1",
      name: "alpha",
      agentKind: "claude",
      status: "working",
      cwd: "/tmp/x",
      title: "claude — x",
      tokens: { ctx_pct: "42" },
      stateChangeSeq: 5,
    });
  });

  test("re-seeding replaces prior state", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1")], [agent("p1", "working", 1)]));
    cache.seedFromSnapshot(snapshot([pane("p9")], []));
    expect(cache.paneIds()).toEqual(["p9"]);
    expect(cache.agents()).toHaveLength(0);
  });
});

describe("status transitions via events", () => {
  test("applies pane.agent_status_changed and is idempotent", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1")], [agent("p1", "working", 3)]));

    const evt = {
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent: "claude", agent_status: "blocked" },
    };
    expect(cache.applyEvent(evt)).toBe(true);
    expect(cache.agents()[0]?.status).toBe("blocked");
    // Duplicate delivery (per-pane stream overlap) must be a no-op.
    expect(cache.applyEvent(evt)).toBe(false);
  });

  test("done status applies; null agent_status maps to unknown", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1")], [agent("p1", "working", 1)]));

    expect(
      cache.applyEvent({
        event: "pane.agent_status_changed",
        data: { pane_id: "p1", agent_status: "done" },
      }),
    ).toBe(true);
    expect(cache.agents()[0]?.status).toBe("done");

    expect(
      cache.applyEvent({
        event: "pane.agent_status_changed",
        data: { pane_id: "p1", agent_status: null },
      }),
    ).toBe(true);
    expect(cache.agents()[0]?.status).toBe("unknown");
  });

  test("status event for unknown pane is ignored without throwing", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1")], []));
    expect(
      cache.applyEvent({
        event: "pane.agent_status_changed",
        data: { pane_id: "ghost", agent_status: "blocked" },
      }),
    ).toBe(false);
  });
});

describe("replay-after-snapshot discard rule", () => {
  test("agent_detected with equal seq is dropped, newer seq kept", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1")], [agent("p1", "working", 5)]));

    // Equal seq: snapshot already reflects it.
    expect(
      cache.applyEvent(
        {
          event: "pane_agent_detected",
          data: { pane_id: "p1", agent: "claude", agent_status: "idle", state_change_seq: 5 },
        },
        { replay: true },
      ),
    ).toBe(false);
    expect(cache.agents()[0]?.status).toBe("working");

    // Strictly newer seq: the event happened after the snapshot.
    expect(
      cache.applyEvent(
        {
          event: "pane_agent_detected",
          data: { pane_id: "p1", agent: "claude", agent_status: "idle", state_change_seq: 6 },
        },
        { replay: true },
      ),
    ).toBe(true);
    const a = cache.agents()[0];
    expect(a?.status).toBe("idle");
    expect(a?.stateChangeSeq).toBe(6);
  });

  test("seq-less status event is dropped on replay but wins live", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1")], [agent("p1", "working", 5)]));

    const evt = {
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "blocked" },
    };
    expect(cache.applyEvent(evt, { replay: true })).toBe(false);
    expect(cache.agents()[0]?.status).toBe("working");

    expect(cache.applyEvent(evt)).toBe(true);
    expect(cache.agents()[0]?.status).toBe("blocked");
  });

  test("replayed pane_created for a snapshot-known pane is dropped; unknown pane kept", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1", { revision: 7 })], []));

    expect(
      cache.applyEvent(
        {
          event: "pane_created",
          data: { type: "pane_created", pane_id: "p1", workspace_id: "ws-1", tab_id: "tab-1" },
        },
        { replay: true },
      ),
    ).toBe(false);

    // Created after the snapshot was taken — must survive replay.
    expect(
      cache.applyEvent(
        {
          event: "pane_created",
          data: { type: "pane_created", pane_id: "p2", workspace_id: "ws-2", tab_id: "tab-2" },
        },
        { replay: true },
      ),
    ).toBe(true);
    expect(cache.paneIds()).toEqual(["p1", "p2"]);
  });
});

describe("pane lifecycle", () => {
  test("pane_closed removes the pane and its agent", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1"), pane("p2")], [agent("p1", "blocked", 2)]));

    expect(cache.applyEvent({ event: "pane_closed", data: { pane_id: "p1" } })).toBe(true);
    expect(cache.paneIds()).toEqual(["p2"]);
    expect(cache.agents()).toHaveLength(0);
    // Closing an unknown pane is a no-op.
    expect(cache.applyEvent({ event: "pane_closed", data: { pane_id: "p1" } })).toBe(false);
  });

  test("pane_moved migrates the key, preserving agent state and seq", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(
      snapshot([pane("p-old")], [agent("p-old", "blocked", 9, { name: "beta" })]),
    );

    expect(
      cache.applyEvent({
        event: "pane_moved",
        data: { old_pane_id: "p-old", pane_id: "p-new", workspace_id: "ws-2" },
      }),
    ).toBe(true);

    expect(cache.paneIds()).toEqual(["p-new"]);
    const a = cache.agents()[0];
    expect(a).toMatchObject({
      paneId: "p-new",
      workspaceId: "ws-2",
      name: "beta",
      status: "blocked",
      stateChangeSeq: 9,
    });
    // Status events now address the new id.
    expect(
      cache.applyEvent({
        event: "pane.agent_status_changed",
        data: { pane_id: "p-new", agent_status: "working" },
      }),
    ).toBe(true);
  });

  test("pane_moved for an unknown pane is ignored", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1")], []));
    expect(
      cache.applyEvent({
        event: "pane_moved",
        data: { old_pane_id: "ghost", pane_id: "ghost-2" },
      }),
    ).toBe(false);
  });

  test("pane_agent_detected marks a pane as an agent pane", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1")], []));
    expect(cache.agents()).toHaveLength(0);

    expect(
      cache.applyEvent({
        event: "pane_agent_detected",
        data: { pane_id: "p1", agent: "codex", agent_status: "working" },
      }),
    ).toBe(true);
    const a = cache.agents()[0];
    expect(a?.agentKind).toBe("codex");
    expect(a?.status).toBe("working");
  });
});

describe("agents() ordering", () => {
  test("blocked, working, done, idle, unknown; stable by paneId within group", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(
      snapshot(
        ["a", "b", "c", "d", "e", "f"].map((id) => pane(id)),
        [
          agent("f", "idle", 1),
          agent("e", "unknown", 1),
          agent("d", "done", 1),
          agent("c", "working", 1),
          agent("b", "blocked", 1),
          agent("a", "blocked", 1),
        ],
      ),
    );
    // f is idle, e is unknown — idle sorts before unknown.
    expect(cache.agents().map((a) => a.paneId)).toEqual(["a", "b", "c", "d", "f", "e"]);
  });
});

describe("robustness", () => {
  test("unknown event names and empty data are ignored", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1")], []));
    expect(cache.applyEvent({ event: "workspace_created", data: {} })).toBe(false);
    expect(cache.applyEvent({ event: "pane_created", data: {} })).toBe(false);
    expect(cache.applyEvent({ event: "pane.agent_status_changed", data: {} })).toBe(false);
  });
});

describe("container close cascades", () => {
  test("workspace_closed removes all its panes without pane_closed events", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot({
      version: "0.8.0",
      protocol: 19,
      workspaces: [
        { workspace_id: "w1", number: 1, label: "a", focused: true, agent_status: "idle" },
        { workspace_id: "w2", number: 2, label: "b", focused: false, agent_status: "idle" },
      ],
      tabs: [],
      layouts: [],
      panes: [
        {
          pane_id: "w1:p1",
          workspace_id: "w1",
          tab_id: "w1:t1",
          agent_status: "idle",
          revision: 1,
          focused: true,
        },
        {
          pane_id: "w2:p1",
          workspace_id: "w2",
          tab_id: "w2:t1",
          agent_status: "idle",
          revision: 1,
          focused: false,
        },
      ],
      agents: [
        {
          terminal_id: "t1",
          pane_id: "w1:p1",
          workspace_id: "w1",
          tab_id: "w1:t1",
          agent: "claude",
          agent_status: "idle",
          state_change_seq: 1,
          revision: 1,
          focused: true,
        },
      ],
    });
    expect(cache.agents()).toHaveLength(1);
    const changed = cache.applyEvent({
      event: "workspace_closed",
      data: { type: "workspace_closed", workspace: { workspace_id: "w1", label: "a" } },
    });
    expect(changed).toBe(true);
    expect(cache.agents()).toHaveLength(0);
    expect(cache.paneIds()).toEqual(["w2:p1"]);
    expect(cache.workspaceLabel("w1")).toBeNull();
  });

  test("tab_closed removes only that tab's panes and drops its label", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot({
      version: "0.8.0",
      protocol: 19,
      workspaces: [
        { workspace_id: "w1", number: 1, label: null, focused: true, agent_status: "idle" },
      ],
      tabs: [
        { tab_id: "w1:t1", workspace_id: "w1", label: "Herddeck" },
        { tab_id: "w1:t2", workspace_id: "w1", label: "Reviewer" },
      ],
      layouts: [],
      panes: [
        {
          pane_id: "w1:p1",
          workspace_id: "w1",
          tab_id: "w1:t1",
          agent_status: "idle",
          revision: 1,
          focused: true,
        },
        {
          pane_id: "w1:p2",
          workspace_id: "w1",
          tab_id: "w1:t2",
          agent_status: "idle",
          revision: 1,
          focused: false,
        },
      ],
      agents: [],
    });
    expect(cache.tabLabel("w1:t2")).toBe("Reviewer");
    expect(
      cache.applyEvent({
        event: "tab_closed",
        data: { type: "tab_closed", tab: { tab_id: "w1:t2" } },
      }),
    ).toBe(true);
    expect(cache.paneIds()).toEqual(["w1:p1"]);
    expect(cache.tabLabel("w1:t2")).toBeNull();
    // The other tab's label is untouched.
    expect(cache.tabLabel("w1:t1")).toBe("Herddeck");
  });
});

describe("tab labels", () => {
  test("seedFromSnapshot seeds tab labels from snap.tabs", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(
      snapshot(
        [pane("p1")],
        [agent("p1", "working", 1)],
        [
          { tab_id: "tab-1", workspace_id: "ws-1", label: "Herddeck" },
          { tab_id: "tab-2", workspace_id: "ws-1", label: null },
        ],
      ),
    );
    expect(cache.tabLabel("tab-1")).toBe("Herddeck");
    expect(cache.tabLabel("tab-2")).toBeNull();
    expect(cache.tabLabel("nope")).toBeNull();
  });

  test("tab_created upserts a label for a new tab (nested data.tab)", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1")], []));
    expect(cache.tabLabel("tab-9")).toBeNull();
    // Label changes don't affect agents(), so this returns false, same
    // as applyWorkspaceUpsert.
    expect(
      cache.applyEvent({
        event: "tab_created",
        data: { type: "tab_created", tab: { tab_id: "tab-9", label: "Reviewer" } },
      }),
    ).toBe(false);
    expect(cache.tabLabel("tab-9")).toBe("Reviewer");
  });

  test("tab_renamed updates an existing label; dotted and underscored spellings both apply", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(
      snapshot([pane("p1")], [], [{ tab_id: "tab-1", workspace_id: "ws-1", label: "old" }]),
    );

    // Underscored spelling, flat data.
    cache.applyEvent({ event: "tab_renamed", data: { tab_id: "tab-1", label: "Dotfiles" } });
    expect(cache.tabLabel("tab-1")).toBe("Dotfiles");

    // Dotted spelling, nested data.tab.
    cache.applyEvent({
      event: "tab.renamed",
      data: { tab: { tab_id: "tab-1", label: "Terminal" } },
    });
    expect(cache.tabLabel("tab-1")).toBe("Terminal");
  });

  test("agents() carries tabLabel resolved from the cache", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(
      snapshot(
        [pane("p1")],
        [agent("p1", "working", 1)],
        [{ tab_id: "tab-1", workspace_id: "ws-1", label: "Herddeck" }],
      ),
    );
    expect(cache.agents()[0]?.tabLabel).toBe("Herddeck");
  });

  test("agents() reports null tabLabel when the tab has none", () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapshot([pane("p1")], [agent("p1", "working", 1)]));
    expect(cache.agents()[0]?.tabLabel).toBeNull();
  });
});

describe("mergeTokensFromSnapshot", () => {
  const snapWith = (tokens?: Record<string, string>) =>
    snapshot([pane("p1")], [agent("p1", "working", 4, tokens ? { tokens } : {})]);

  const seeded = () => {
    const cache = new StateCache();
    cache.seedFromSnapshot(snapWith({ ctx_pct: "10" }));
    return cache;
  };

  test("updates a changed token and reports the change", () => {
    const cache = seeded();
    expect(cache.mergeTokensFromSnapshot(snapWith({ ctx_pct: "73" }))).toBe(true);
    expect(cache.agents()[0]?.tokens.ctx_pct).toBe("73");
  });

  test("reports no change for identical tokens", () => {
    const cache = seeded();
    expect(cache.mergeTokensFromSnapshot(snapWith({ ctx_pct: "10" }))).toBe(false);
  });

  test("treats a dropped token as a change", () => {
    // herdr metadata does not survive a server restart; the donut must
    // go dark rather than keep rendering a value that no longer exists.
    const cache = seeded();
    expect(cache.mergeTokensFromSnapshot(snapWith())).toBe(true);
    expect(cache.agents()[0]?.tokens).toEqual({});
  });

  test("ignores agents for panes the cache no longer holds", () => {
    const cache = seeded();
    const snap = snapshot(
      [pane("gone")],
      [agent("gone", "working", 4, { tokens: { ctx_pct: "73" } })],
    );
    expect(cache.mergeTokensFromSnapshot(snap)).toBe(false);
    expect(cache.agents()[0]?.tokens.ctx_pct).toBe("10");
  });

  test("touches tokens only, leaving event-owned state alone", () => {
    // The refresh runs on a timer against a snapshot that may be older
    // than pushed events already applied; merging anything else would
    // regress live state.
    const cache = seeded();
    cache.applyEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "blocked" },
    });
    expect(cache.agents()[0]?.status).toBe("blocked");

    cache.mergeTokensFromSnapshot(snapWith({ ctx_pct: "73" }));
    expect(cache.agents()[0]?.status).toBe("blocked"); // not back to "working"
    expect(cache.agents()[0]?.tokens.ctx_pct).toBe("73");
  });
});
