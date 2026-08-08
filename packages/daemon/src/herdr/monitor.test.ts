import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CachedAgent } from "../stateCache.ts";
import { MockHerdr, emptySnapshot } from "./mockServer.ts";
import { TargetMonitor, type TargetState } from "./monitor.ts";

// Unix socket paths are capped (~104 bytes on macOS), so sockets live
// in a short mkdtemp dir rather than the session scratchpad.
let dir: string;
let sockPath: string;
let mock: MockHerdr;
let monitor: TargetMonitor | null;

interface StatusSeen {
  state: TargetState;
  protocol: number | null;
}

function makeRecorder() {
  const statuses: StatusSeen[] = [];
  const agentUpdates: CachedAgent[][] = [];
  const statusWaiters: Array<{
    pred: (s: StatusSeen) => boolean;
    resolve: (s: StatusSeen) => void;
  }> = [];
  const agentWaiters: Array<{
    pred: (a: CachedAgent[]) => boolean;
    resolve: (a: CachedAgent[]) => void;
  }> = [];

  return {
    statuses,
    agentUpdates,
    events: {
      status(state: TargetState, protocol: number | null) {
        const seen = { state, protocol };
        statuses.push(seen);
        for (let i = statusWaiters.length - 1; i >= 0; i--) {
          const w = statusWaiters[i];
          if (w?.pred(seen)) {
            statusWaiters.splice(i, 1);
            w.resolve(seen);
          }
        }
      },
      agentsChanged(agents: CachedAgent[]) {
        agentUpdates.push(agents);
        for (let i = agentWaiters.length - 1; i >= 0; i--) {
          const w = agentWaiters[i];
          if (w?.pred(agents)) {
            agentWaiters.splice(i, 1);
            w.resolve(agents);
          }
        }
      },
    },
    /** Resolves on a past or future status matching pred. */
    waitStatus(pred: (s: StatusSeen) => boolean, after = 0): Promise<StatusSeen> {
      const hit = statuses.slice(after).find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => statusWaiters.push({ pred, resolve }));
    },
    /** Resolves on a past or future agents update matching pred. */
    waitAgents(pred: (a: CachedAgent[]) => boolean, after = 0): Promise<CachedAgent[]> {
      const hit = agentUpdates.slice(after).find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => agentWaiters.push({ pred, resolve }));
    },
  };
}

function seedMockSession(): void {
  mock.snapshot = {
    ...emptySnapshot(),
    workspaces: [
      { workspace_id: "ws-1", number: 1, label: "main", focused: true, agent_status: "idle" },
    ],
    panes: [
      {
        pane_id: "p1",
        workspace_id: "ws-1",
        tab_id: "tab-1",
        agent_status: "working",
        revision: 1,
        focused: true,
      },
    ],
    agents: [
      {
        terminal_id: "term-p1",
        pane_id: "p1",
        workspace_id: "ws-1",
        tab_id: "tab-1",
        agent: "claude",
        name: "alpha",
        agent_status: "working",
        state_change_seq: 4,
        revision: 1,
        focused: true,
      },
    ],
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "herddeck-mon-"));
  sockPath = path.join(dir, "herdr.sock");
  mock = new MockHerdr(sockPath);
  monitor = null;
});

afterEach(async () => {
  monitor?.stop();
  await mock.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("TargetMonitor", () => {
  test("happy path: ping, lifecycle sub, snapshot, per-pane sub, live status flows out", async () => {
    seedMockSession();
    await mock.listen();
    const rec = makeRecorder();
    monitor = new TargetMonitor("local", sockPath, rec.events, { backoffMs: [10, 100] });
    monitor.start();

    await rec.waitStatus((s) => s.state === "online");
    expect(rec.statuses[0]?.state).toBe("connecting");
    expect(rec.statuses.at(-1)).toEqual({ state: "online", protocol: 19 });

    // Verified race-free ordering on the wire.
    expect(mock.requests.map((r) => r.method)).toEqual([
      "ping",
      "events.subscribe",
      "session.snapshot",
      "events.subscribe",
    ]);
    const lifecycle = mock.streams[0];
    const perPane = mock.streams[1];
    expect(lifecycle?.paneIds()).toEqual([]);
    expect(lifecycle?.subTypes()).toContain("pane.created");
    expect(perPane?.subTypes()).toEqual(["pane.agent_status_changed"]);
    expect(perPane?.paneIds()).toEqual(["p1"]);

    // Seed emission carries the snapshot agent.
    const seeded = await rec.waitAgents((a) => a.length === 1);
    expect(seeded[0]).toMatchObject({ paneId: "p1", status: "working", name: "alpha" });

    // Live status event on the per-pane stream reaches agentsChanged.
    perPane?.push("pane.agent_status_changed", {
      pane_id: "p1",
      agent: "claude",
      agent_status: "blocked",
    });
    const updated = await rec.waitAgents((a) => a[0]?.status === "blocked");
    expect(updated).toHaveLength(1);
  });

  test("reconnects after the server drops", async () => {
    seedMockSession();
    await mock.listen();
    const rec = makeRecorder();
    monitor = new TargetMonitor("local", sockPath, rec.events, { backoffMs: [10, 100] });
    monitor.start();
    await rec.waitStatus((s) => s.state === "online");
    const firstConnections = mock.connectionCount;

    await mock.stop(); // drops both streams
    await rec.waitStatus((s) => s.state === "offline" || s.state === "connecting", 1);

    await mock.listen();
    const statusesBefore = rec.statuses.length;
    await rec.waitStatus((s) => s.state === "online", statusesBefore);
    // A full second cycle ran: new connections, streams reopened.
    expect(mock.connectionCount).toBeGreaterThan(0);
    expect(firstConnections).toBeGreaterThan(0);
    const lastPerPane = mock.streams.at(-1);
    expect(lastPerPane?.paneIds()).toEqual(["p1"]);
  });

  test("absent socket: offline, then backoff retry connects once the server appears", async () => {
    // No listen() — ENOENT on connect.
    seedMockSession();
    const rec = makeRecorder();
    monitor = new TargetMonitor("local", sockPath, rec.events, { backoffMs: [10, 100] });
    monitor.start();

    await rec.waitStatus((s) => s.state === "offline");
    expect(mock.connectionCount).toBe(0);

    await mock.listen();
    await rec.waitStatus((s) => s.state === "online");
    expect(mock.requests.some((r) => r.method === "session.snapshot")).toBe(true);
  });

  test("protocol mismatch: degraded status but still connects and serves agents", async () => {
    seedMockSession();
    mock.protocol = 18;
    await mock.listen();
    const rec = makeRecorder();
    monitor = new TargetMonitor("local", sockPath, rec.events, { backoffMs: [10, 100] });
    monitor.start();

    const mismatch = await rec.waitStatus((s) => s.state === "protocol-mismatch");
    expect(mismatch.protocol).toBe(18);

    // Still usable: full connect sequence completes and agents flow.
    const agents = await rec.waitAgents((a) => a.length === 1);
    expect(agents[0]?.paneId).toBe("p1");
    expect(mock.requests.map((r) => r.method)).toEqual([
      "ping",
      "events.subscribe",
      "session.snapshot",
      "events.subscribe",
    ]);
    // "online" must never mask the mismatch warning.
    expect(rec.statuses.some((s) => s.state === "online")).toBe(false);
  });

  test("pane_created reopens the per-pane stream make-before-break", async () => {
    seedMockSession();
    await mock.listen();
    const rec = makeRecorder();
    monitor = new TargetMonitor("local", sockPath, rec.events, { backoffMs: [10, 100] });
    monitor.start();
    await rec.waitStatus((s) => s.state === "online");

    const lifecycle = mock.streams[0];
    const oldPerPane = mock.streams[1];
    expect(oldPerPane?.paneIds()).toEqual(["p1"]);

    lifecycle?.push("pane_created", {
      type: "pane_created",
      pane_id: "p2",
      workspace_id: "ws-1",
      tab_id: "tab-1",
    });

    // A NEW events.subscribe must arrive covering both panes.
    const newPerPane = await mock.waitForStream((s) => s.paneIds().length === 2);
    expect(newPerPane.paneIds()).toEqual(["p1", "p2"]);
    // Make-before-break: the old stream was still open when the new
    // one went live...
    expect(oldPerPane?.clientClosed).toBe(false);
    // ...and only closes after.
    await oldPerPane?.clientClose;

    // The new stream is the live one: events on it flow through.
    newPerPane.push("pane.agent_status_changed", {
      pane_id: "p1",
      agent: "claude",
      agent_status: "done",
    });
    await rec.waitAgents((a) => a[0]?.status === "done");
  });
});

describe("stale pane subscriptions", () => {
  test("prunes a vanished pane instead of reconnect-flapping", async () => {
    seedMockSession();
    // A second pane the server no longer knows: every batch naming it
    // fails whole (herdr's all-or-nothing subscribe).
    mock.snapshot.panes.push({
      pane_id: "p2",
      workspace_id: "ws-1",
      tab_id: "tab-1",
      agent_status: "idle",
      revision: 1,
      focused: false,
    });
    mock.rejectPaneIds.add("p2");
    await mock.listen();

    const rec = makeRecorder();
    monitor = new TargetMonitor("local", sockPath, rec.events, { backoffMs: [10, 100] });
    monitor.start();
    await rec.waitStatus((s) => s.state === "online");
    await new Promise((r) => setTimeout(r, 250));

    // Pre-fix: an endless online→connecting loop, because every
    // reconnect rebuilt the same doomed batch.
    expect(rec.statuses.filter((s) => s.state === "connecting").length).toBe(1);
    expect(rec.statuses[rec.statuses.length - 1]?.state).toBe("online");
    expect(monitor.cache.paneIds()).toEqual(["p1"]);
  });
});

describe("context-donut token refresh", () => {
  test("picks up a token change that arrives with no event at all", async () => {
    // The regression this whole path exists for. Verified live against
    // herdr 0.8.0: pane.report_metadata emits NO event, and
    // pane.agent_status_changed carries only {pane_id, agent_status}.
    // So an agent's statusline can report a fresh ctx_pct every turn
    // and — without this refresh — the daemon would never learn of it,
    // leaving the Stream Deck donut frozen at whatever it read when it
    // first connected.
    seedMockSession();
    mock.snapshot.agents[0]!.tokens = { ctx_pct: "10" };
    await mock.listen();

    const rec = makeRecorder();
    monitor = new TargetMonitor("local", sockPath, rec.events, {
      backoffMs: [10, 100],
      tokensRefreshMs: 30,
    });
    monitor.start();

    await rec.waitAgents((a) => a[0]?.tokens.ctx_pct === "10");

    // Server-side change only: no event is pushed on any stream.
    mock.snapshot.agents[0]!.tokens = { ctx_pct: "73" };

    const updated = await rec.waitAgents((a) => a[0]?.tokens.ctx_pct === "73");
    expect(updated[0]?.tokens.ctx_pct).toBe("73");
  });

  test("does not emit when the tokens are unchanged", async () => {
    // A key that redraws every 10s for no reason is churn the Stream
    // Deck pays for; only real changes may reach the plugin.
    seedMockSession();
    mock.snapshot.agents[0]!.tokens = { ctx_pct: "42" };
    await mock.listen();

    const rec = makeRecorder();
    monitor = new TargetMonitor("local", sockPath, rec.events, {
      backoffMs: [10, 100],
      tokensRefreshMs: 20,
    });
    monitor.start();
    await rec.waitStatus((s) => s.state === "online");
    const after = rec.agentUpdates.length;

    await new Promise((r) => setTimeout(r, 150)); // several refresh ticks
    expect(rec.agentUpdates.length).toBe(after);
    // ...and the refreshes really did happen.
    expect(mock.requests.filter((r) => r.method === "session.snapshot").length).toBeGreaterThan(1);
  });

  test("refreshing never resurrects a pane the event path removed", async () => {
    // The refresh re-reads a full snapshot but must merge tokens ONLY:
    // re-seeding would let a stale snapshot undo a close that a newer
    // pushed event already applied.
    seedMockSession();
    await mock.listen();

    const rec = makeRecorder();
    monitor = new TargetMonitor("local", sockPath, rec.events, {
      backoffMs: [10, 100],
      tokensRefreshMs: 20,
    });
    monitor.start();
    await rec.waitStatus((s) => s.state === "online");

    mock.streams[0]?.push("pane_closed", { pane_id: "p1" });
    await rec.waitAgents((a) => a.length === 0);

    // The mock's snapshot still lists p1 — several refreshes must not
    // bring it back.
    await new Promise((r) => setTimeout(r, 120));
    expect(monitor.cache.paneIds()).toEqual([]);
    expect(rec.agentUpdates.at(-1)).toEqual([]);
  });

  test("tokensRefreshMs: 0 disables the poll entirely", async () => {
    seedMockSession();
    await mock.listen();

    const rec = makeRecorder();
    monitor = new TargetMonitor("local", sockPath, rec.events, {
      backoffMs: [10, 100],
      tokensRefreshMs: 0,
    });
    monitor.start();
    await rec.waitStatus((s) => s.state === "online");

    await new Promise((r) => setTimeout(r, 120));
    expect(mock.requests.filter((r) => r.method === "session.snapshot").length).toBe(1);
  });
});
