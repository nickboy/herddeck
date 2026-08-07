// Full-stack live test: daemon (spawned) ↔ WS client, against the
// herddeck-test session. Verifies daemon:ready, targets:update
// online, agents:update on injection, and the agent:answer command
// round-trip (keys land in the pane, via the pane.send_keys fallback
// for injected agents). Cleans up its workspace.
//
// Run: bun packages/daemon/test/integration/live-e2e.ts
// Requires: herddeck-test server running; port 9139 free.

import { HerdrClient } from "../../src/herdr/client.ts";

const CONFIG = "/tmp/herddeck-e2e/config.toml";
const PORT = 9139;
const SOCKET = `${process.env.HOME}/.config/herdr/sessions/herddeck-test/herdr.sock`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// The daemon wiring runs inline in this process (loadConfig takes an
// explicit path, so no env override or spawn indirection is needed).
const { loadConfig } = await import("../../src/config.ts");
const { SessionRegistry } = await import("../../src/registry.ts");
const { DeckServer } = await import("../../src/server.ts");

const config = loadConfig(CONFIG);
let server: DeckServer;
const registry = new SessionRegistry(config, {
  targetsChanged: (targets) => server?.broadcast({ type: "targets:update", targets }),
  agentsChanged: (agents) => server?.broadcast({ type: "agents:update", agents }),
});
server = new DeckServer({
  registry,
  version: "e2e",
  focusTerminal: async () => {
    focusCalled = true;
  },
  wispr: { start: () => {}, stop: () => {} },
});
let focusCalled = false;
server.start(PORT);
registry.start();

const received: Array<Record<string, unknown>> = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.onmessage = (m) => received.push(JSON.parse(String(m.data)));
await sleep(1200);

const types = () => received.map((e) => e.type);
if (!types().includes("daemon:ready")) fail("no daemon:ready");
const online = received.find(
  (e) =>
    e.type === "targets:update" &&
    (e.targets as Array<{ state: string }>).some((t) => t.state === "online"),
);
if (!online) fail(`target never online (${JSON.stringify(received.slice(0, 4))})`);

// Inject an agent; expect agents:update with blocked status.
const direct = new HerdrClient(SOCKET);
const ws2 = await direct.call<Record<string, unknown>>("workspace.create", {
  label: "e2e",
  cwd: process.env.HOME,
});
const paneId = (ws2.root_pane as Record<string, unknown>).pane_id as string;
const wsId = (ws2.workspace as Record<string, unknown>).workspace_id as string;
await sleep(500);
await direct.call("pane.report_agent", {
  pane_id: paneId,
  source: "custom:herddeck-e2e",
  agent: "claude",
  state: "blocked",
  seq: 1,
});
await sleep(700);
const blockedUpdate = received.find(
  (e) =>
    e.type === "agents:update" &&
    (e.agents as Array<{ paneId: string; status: string }>).some(
      (a) => a.paneId === paneId && a.status === "blocked",
    ),
);
if (!blockedUpdate) fail("no agents:update with blocked agent");

// Command round-trip: agent:answer yes → keys land in the pane.
ws.send(JSON.stringify({ type: "agent:answer", target: "test", paneId, kind: "yes" }));
await sleep(800);
const read = await direct.call<{ read: { text: string } }>("pane.read", {
  pane_id: paneId,
  source: "visible",
  lines: 4,
});
if (!read.read.text.includes("1")) fail(`answer keys did not land: ${JSON.stringify(read.read)}`);

// Focus command flags the local-target foreground hook.
ws.send(JSON.stringify({ type: "agent:focus", target: "test", paneId }));
await sleep(500);
if (!focusCalled) fail("agent:focus did not trigger terminal foregrounding");

await direct.call("workspace.close", { workspace_id: wsId });
await sleep(2500);
const lastAgents = [...received].reverse().find((e) => e.type === "agents:update");
if (((lastAgents?.agents as unknown[]) ?? []).length !== 0) fail("agents not cleared after close");

console.log("PASS: ready, online, injection update, answer round-trip, focus, cleanup");
ws.close();
registry.stop();
server.stop();
process.exit(0);
