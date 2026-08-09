// Unit tests for DeckServer against a stub SessionRegistry — no herdr
// socket, no live process. The only live-socket coverage is
// packages/daemon/test/integration/live-e2e.ts, which CI can't run
// (needs a running herdr `herddeck-test` session); these tests exist
// so DeckServer's command dispatch and broadcast fan-out are covered
// in CI too.
//
// Each test binds its own port (a per-file base, incremented per
// test) and drives the server with a real WebSocket client, matching
// the wire protocol end to end rather than calling private methods.

import { afterEach, describe, expect, test } from "bun:test";
import { answerKeys } from "./answerMap";
import { HerdrApiError } from "./herdr/client";
import type { SessionRegistry } from "./registry";
import { DeckServer, type ServerDeps } from "./server";
import type { CachedAgent } from "./stateCache";
import type { AgentSnapshot, TargetSnapshot, WsEvent } from "./wire";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await sleep(5);
  }
}

interface RecordedCall {
  method: string;
  params: unknown;
}

interface StubMonitor {
  calls: RecordedCall[];
  call: (method: string, params?: unknown) => Promise<unknown>;
}

/** Records every call(); replies via `handlers[method]`, default `{}`.
 * A handler that throws makes the recorded call reject, same as a
 * real TargetMonitor.call() rejecting on a herdr error envelope. */
function makeMonitor(handlers: Record<string, (params: unknown) => unknown> = {}): StubMonitor {
  const calls: RecordedCall[] = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      const handler = handlers[method];
      return handler ? handler(params) : {};
    },
  };
}

interface RegistryStubOpts {
  /** Targets configured with focus_terminal = false. */
  noFocusTargets?: string[];
  monitors?: Record<string, StubMonitor>;
  agents?: Record<string, CachedAgent>;
  targets?: TargetSnapshot[];
}

/** DeckServer only ever calls monitorFor/agentFor/targetSnapshots on
 * the registry, so the stub implements exactly those three and is
 * cast through `unknown` — SessionRegistry is a concrete class, not
 * an interface, so there's no structural type to satisfy honestly. */
function makeRegistry(opts: RegistryStubOpts): SessionRegistry {
  const monitors = opts.monitors ?? {};
  const agents = opts.agents ?? {};
  const targets = opts.targets ?? [];
  return {
    monitorFor: (target: string) => monitors[target] ?? null,
    agentFor: (target: string, paneId: string) => agents[`${target}:${paneId}`] ?? null,
    targetSnapshots: () => targets,
    // focus_terminal defaults true for every configured target; the
    // stub mirrors that, with opts.noFocusTargets opting specific ones
    // out (and unknown targets false, like the real registry).
    focusTerminalFor: (target: string) =>
      targets.some((t) => t.name === target) && !(opts.noFocusTargets ?? []).includes(target),
  } as unknown as SessionRegistry;
}

function makeCachedAgent(overrides: Partial<CachedAgent> = {}): CachedAgent {
  return {
    paneId: "p1",
    workspaceId: "ws-1",
    tabId: "tab-1",
    name: "alpha",
    agentKind: "claude",
    focused: false,
    status: "blocked",
    cwd: null,
    title: null,
    tabLabel: null,
    tokens: {},
    stateChangeSeq: 1,
    revision: 1,
    ...overrides,
  };
}

function makeDeps(registry: SessionRegistry): {
  deps: ServerDeps;
  focusCalls: unknown[];
  wisprCalls: Array<"start" | "stop">;
} {
  const focusCalls: unknown[] = [];
  const wisprCalls: Array<"start" | "stop"> = [];
  const deps: ServerDeps = {
    registry,
    version: "test-1.0",
    focusTerminal: async () => {
      focusCalls.push(true);
    },
    wispr: {
      start: () => wisprCalls.push("start"),
      stop: () => wisprCalls.push("stop"),
    },
  };
  return { deps, focusCalls, wisprCalls };
}

function connectClient(port: number): Promise<{ ws: WebSocket; received: WsEvent[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: WsEvent[] = [];
    ws.onmessage = (m) => received.push(JSON.parse(String(m.data)) as WsEvent);
    ws.onopen = () => resolve({ ws, received });
    ws.onerror = (err) => reject(err);
  });
}

const sampleTarget: TargetSnapshot = {
  name: "local",
  kind: "local",
  state: "online",
  protocol: 19,
};
const sampleAgent: AgentSnapshot = {
  target: "local",
  paneId: "p1",
  name: "alpha",
  agentKind: "claude",
  focused: false,
  status: "blocked",
  workspaceLabel: "main",
  cwd: null,
  title: null,
  tabLabel: null,
  ctxPct: null,
  stateChangeSeq: 1,
};

let port = 19741;
function nextPort(): number {
  return port++;
}

let server: DeckServer | null = null;
let sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
  sockets = [];
  server?.stop();
  server = null;
});

describe("DeckServer", () => {
  test("open: daemon:ready, targets:update, agents:update arrive in order with last-known state", async () => {
    const registry = makeRegistry({});
    const { deps } = makeDeps(registry);
    server = new DeckServer(deps);
    const p = nextPort();
    server.start(p);
    // Set last-known state before any client connects.
    server.broadcast({ type: "targets:update", targets: [sampleTarget] });
    server.broadcast({ type: "agents:update", agents: [sampleAgent] });

    const { ws, received } = await connectClient(p);
    sockets.push(ws);
    await waitUntil(() => received.length >= 3);

    expect(received.map((e) => e.type)).toEqual([
      "daemon:ready",
      "targets:update",
      "agents:update",
    ]);
    expect(received[0]).toEqual({ type: "daemon:ready", version: deps.version });
    expect(received[1]).toEqual({ type: "targets:update", targets: [sampleTarget] });
    expect(received[2]).toEqual({ type: "agents:update", agents: [sampleAgent] });
  });

  test("broadcast fans out to connected clients; late joiners get last-known state", async () => {
    const registry = makeRegistry({});
    const { deps } = makeDeps(registry);
    server = new DeckServer(deps);
    const p = nextPort();
    server.start(p);

    const c1 = await connectClient(p);
    sockets.push(c1.ws);
    await waitUntil(() => c1.received.length >= 3);

    server.broadcast({ type: "targets:update", targets: [sampleTarget] });
    await waitUntil(() => c1.received.length >= 4);
    expect(c1.received.at(-1)).toEqual({ type: "targets:update", targets: [sampleTarget] });

    // Late joiner: gets the retained last-known targets, not the
    // server's empty startup default.
    const c2 = await connectClient(p);
    sockets.push(c2.ws);
    await waitUntil(() => c2.received.length >= 3);
    expect(c2.received[1]).toEqual({ type: "targets:update", targets: [sampleTarget] });
    expect(c2.received[2]).toEqual({ type: "agents:update", agents: [] });

    // Fan-out: a later broadcast reaches every connected client.
    server.broadcast({ type: "agents:update", agents: [sampleAgent] });
    await waitUntil(() => c1.received.length >= 5 && c2.received.length >= 4);
    expect(c1.received.at(-1)).toEqual({ type: "agents:update", agents: [sampleAgent] });
    expect(c2.received.at(-1)).toEqual({ type: "agents:update", agents: [sampleAgent] });
  });

  test("GET /health returns ok, version, targets, agents, plugin count", async () => {
    const registry = makeRegistry({});
    const { deps } = makeDeps(registry);
    server = new DeckServer(deps);
    const p = nextPort();
    server.start(p);
    server.broadcast({ type: "targets:update", targets: [sampleTarget] });
    server.broadcast({ type: "agents:update", agents: [sampleAgent] });

    const c1 = await connectClient(p);
    sockets.push(c1.ws);
    await waitUntil(() => c1.received.length >= 3);

    const res = await fetch(`http://127.0.0.1:${p}/health`);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      version: deps.version,
      targets: [sampleTarget],
      agents: [sampleAgent],
      plugins: 1,
    });
  });

  describe("agent:answer", () => {
    test("agent_not_ready falls back to pane.send_keys with the same keys", async () => {
      const monitor = makeMonitor({
        "agent.send_keys": () => {
          throw new HerdrApiError("agent_not_ready", "not ready");
        },
      });
      const registry = makeRegistry({
        monitors: { local: monitor },
        agents: { "local:p1": makeCachedAgent({ agentKind: "claude" }) },
      });
      const { deps } = makeDeps(registry);
      server = new DeckServer(deps);
      const p = nextPort();
      server.start(p);
      const { ws, received } = await connectClient(p);
      sockets.push(ws);
      await waitUntil(() => received.length >= 3);

      ws.send(JSON.stringify({ type: "agent:answer", target: "local", paneId: "p1", kind: "yes" }));
      await waitUntil(() => monitor.calls.some((c) => c.method === "pane.send_keys"));

      const keys = answerKeys("claude", "yes");
      expect(monitor.calls.map((c) => c.method)).toEqual(["agent.send_keys", "pane.send_keys"]);
      expect(monitor.calls[0]?.params).toEqual({ target: "p1", keys });
      expect(monitor.calls[1]?.params).toEqual({ pane_id: "p1", keys });
    });

    test("working agent.send_keys does not fall back to pane.send_keys", async () => {
      const monitor = makeMonitor({ "agent.send_keys": () => ({ ok: true }) });
      const registry = makeRegistry({
        monitors: { local: monitor },
        agents: { "local:p1": makeCachedAgent({ agentKind: "claude" }) },
      });
      const { deps } = makeDeps(registry);
      server = new DeckServer(deps);
      const p = nextPort();
      server.start(p);
      const { ws, received } = await connectClient(p);
      sockets.push(ws);
      await waitUntil(() => received.length >= 3);

      ws.send(
        JSON.stringify({ type: "agent:answer", target: "local", paneId: "p1", kind: "always" }),
      );
      await waitUntil(() => monitor.calls.length >= 1);
      await sleep(30); // give a wrongful fallback call a chance to land

      const keys = answerKeys("claude", "always");
      expect(monitor.calls).toEqual([
        { method: "agent.send_keys", params: { target: "p1", keys } },
      ]);
    });
  });

  describe("agent:focus", () => {
    test("local target calls agent.focus then focusTerminal", async () => {
      const monitor = makeMonitor();
      const registry = makeRegistry({
        monitors: { local: monitor },
        targets: [sampleTarget],
      });
      const { deps, focusCalls } = makeDeps(registry);
      server = new DeckServer(deps);
      const p = nextPort();
      server.start(p);
      const { ws, received } = await connectClient(p);
      sockets.push(ws);
      await waitUntil(() => received.length >= 3);

      ws.send(JSON.stringify({ type: "agent:focus", target: "local", paneId: "p1" }));
      await waitUntil(() => focusCalls.length >= 1);

      expect(monitor.calls).toEqual([{ method: "agent.focus", params: { target: "p1" } }]);
    });

    test("remote target also foregrounds the terminal (deck-side viewing is the norm)", async () => {
      const monitor = makeMonitor();
      const registry = makeRegistry({
        monitors: { workbox: monitor },
        targets: [{ name: "workbox", kind: "remote", state: "online", protocol: 19 }],
      });
      const { deps, focusCalls } = makeDeps(registry);
      server = new DeckServer(deps);
      const p = nextPort();
      server.start(p);
      const { ws, received } = await connectClient(p);
      sockets.push(ws);
      await waitUntil(() => received.length >= 3);

      ws.send(JSON.stringify({ type: "agent:focus", target: "workbox", paneId: "p1" }));
      await waitUntil(() => focusCalls.length >= 1);

      expect(monitor.calls).toEqual([{ method: "agent.focus", params: { target: "p1" } }]);
    });

    test("focus_terminal = false opts a target out of foregrounding", async () => {
      const monitor = makeMonitor();
      const registry = makeRegistry({
        monitors: { workbox: monitor },
        targets: [{ name: "workbox", kind: "remote", state: "online", protocol: 19 }],
        noFocusTargets: ["workbox"],
      });
      const { deps, focusCalls } = makeDeps(registry);
      server = new DeckServer(deps);
      const p = nextPort();
      server.start(p);
      const { ws, received } = await connectClient(p);
      sockets.push(ws);
      await waitUntil(() => received.length >= 3);

      ws.send(JSON.stringify({ type: "agent:focus", target: "workbox", paneId: "p1" }));
      await waitUntil(() => monitor.calls.length >= 1);
      await sleep(30);

      expect(focusCalls).toEqual([]);
    });

    test("unknown target: no monitor, dispatch returns without throwing", async () => {
      const registry = makeRegistry({});
      const { deps, focusCalls } = makeDeps(registry);
      server = new DeckServer(deps);
      const p = nextPort();
      server.start(p);
      const { ws, received } = await connectClient(p);
      sockets.push(ws);
      await waitUntil(() => received.length >= 3);

      ws.send(JSON.stringify({ type: "agent:focus", target: "ghost", paneId: "p1" }));
      await sleep(30);

      expect(focusCalls).toEqual([]);
      expect(ws.readyState).toBe(WebSocket.OPEN);

      // Connection survives and still answers a subsequent valid command.
      ws.send(JSON.stringify({ type: "wispr-flow:start" }));
      const before = received.length;
      await sleep(30);
      expect(received.length).toBe(before);
    });
  });

  test("agent:keys passes through to pane.send_keys", async () => {
    const monitor = makeMonitor();
    const registry = makeRegistry({ monitors: { local: monitor } });
    const { deps } = makeDeps(registry);
    server = new DeckServer(deps);
    const p = nextPort();
    server.start(p);
    const { ws, received } = await connectClient(p);
    sockets.push(ws);
    await waitUntil(() => received.length >= 3);

    ws.send(
      JSON.stringify({ type: "agent:keys", target: "local", paneId: "p1", keys: ["a", "enter"] }),
    );
    await waitUntil(() => monitor.calls.length >= 1);

    expect(monitor.calls).toEqual([
      { method: "pane.send_keys", params: { pane_id: "p1", keys: ["a", "enter"] } },
    ]);
  });

  test("prompt:canned calls agent.prompt", async () => {
    const monitor = makeMonitor();
    const registry = makeRegistry({ monitors: { local: monitor } });
    const { deps } = makeDeps(registry);
    server = new DeckServer(deps);
    const p = nextPort();
    server.start(p);
    const { ws, received } = await connectClient(p);
    sockets.push(ws);
    await waitUntil(() => received.length >= 3);

    ws.send(
      JSON.stringify({ type: "prompt:canned", target: "local", paneId: "p1", text: "status?" }),
    );
    await waitUntil(() => monitor.calls.length >= 1);

    expect(monitor.calls).toEqual([
      { method: "agent.prompt", params: { target: "p1", text: "status?" } },
    ]);
  });

  test("worktree:create calls worktree.create with focus true", async () => {
    const monitor = makeMonitor();
    const registry = makeRegistry({ monitors: { local: monitor } });
    const { deps } = makeDeps(registry);
    server = new DeckServer(deps);
    const p = nextPort();
    server.start(p);
    const { ws, received } = await connectClient(p);
    sockets.push(ws);
    await waitUntil(() => received.length >= 3);

    ws.send(JSON.stringify({ type: "worktree:create", target: "local", workspaceId: "ws-9" }));
    await waitUntil(() => monitor.calls.length >= 1);

    expect(monitor.calls).toEqual([
      { method: "worktree.create", params: { workspace_id: "ws-9", focus: true } },
    ]);
  });

  test("wispr-flow:start/stop call deps.wispr", async () => {
    const registry = makeRegistry({});
    const { deps, wisprCalls } = makeDeps(registry);
    server = new DeckServer(deps);
    const p = nextPort();
    server.start(p);
    const { ws, received } = await connectClient(p);
    sockets.push(ws);
    await waitUntil(() => received.length >= 3);

    ws.send(JSON.stringify({ type: "wispr-flow:start" }));
    await waitUntil(() => wisprCalls.length >= 1);
    ws.send(JSON.stringify({ type: "wispr-flow:stop" }));
    await waitUntil(() => wisprCalls.length >= 2);

    expect(wisprCalls).toEqual(["start", "stop"]);
  });

  test("malformed JSON command does not crash the connection; a later valid command still works", async () => {
    const registry = makeRegistry({});
    const { deps, wisprCalls } = makeDeps(registry);
    server = new DeckServer(deps);
    const p = nextPort();
    server.start(p);
    const { ws, received } = await connectClient(p);
    sockets.push(ws);
    await waitUntil(() => received.length >= 3);

    ws.send("not json{{{");
    await sleep(30);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.send(JSON.stringify({ type: "wispr-flow:start" }));
    await waitUntil(() => wisprCalls.length >= 1);
    expect(wisprCalls).toEqual(["start"]);
  });
});

describe("token auth", () => {
  test("rejects /health and /ws without the token; accepts bearer and query", async () => {
    const registry = makeRegistry({});
    const { deps } = makeDeps(registry);
    deps.token = "sekret";
    server = new DeckServer(deps);
    const p = nextPort();
    server.start(p);

    const noAuth = await fetch(`http://127.0.0.1:${p}/health`);
    expect(noAuth.status).toBe(401);
    const bearer = await fetch(`http://127.0.0.1:${p}/health`, {
      headers: { authorization: "Bearer sekret" },
    });
    expect(bearer.status).toBe(200);

    const wsBad = new WebSocket(`ws://127.0.0.1:${p}/ws`);
    await new Promise<void>((res) => {
      wsBad.onclose = () => res();
      wsBad.onerror = () => {};
    });

    const wsGood = new WebSocket(`ws://127.0.0.1:${p}/ws?token=sekret`);
    const opened = await new Promise<boolean>((res) => {
      wsGood.onopen = () => res(true);
      wsGood.onclose = () => res(false);
      wsGood.onerror = () => {};
    });
    expect(opened).toBe(true);
    wsGood.close();
  });
});
