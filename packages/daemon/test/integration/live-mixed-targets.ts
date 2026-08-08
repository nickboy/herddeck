// Matrix T9: local + remote targets in one deck. Runs the daemon
// wiring inline with a config carrying both a local target (this
// machine's default herdr session) and a remote target reached through
// a real ssh streamlocal forward, then asserts the plugin-facing agent
// list merges both and that commands route to the right socket.
//
// Requires: sshd reachable as the ssh alias in the config (Tier-1 fake
// remote), the remote-side session running, and a local herdr server.
// Guarded: HERDDECK_FAKE_REMOTE=1.
//
// Run: HERDDECK_FAKE_REMOTE=1 bun packages/daemon/test/integration/live-mixed-targets.ts [configPath]

import { loadConfig } from "../../src/config.ts";
import { HerdrClient } from "../../src/herdr/client.ts";
import { ensureRunDir } from "../../src/paths.ts";
import { SessionRegistry } from "../../src/registry.ts";
import { DeckServer } from "../../src/server.ts";
import { TunnelManager } from "../../src/tunnel.ts";

if (process.env.HERDDECK_FAKE_REMOTE !== "1") {
  console.log("SKIP: set HERDDECK_FAKE_REMOTE=1 (needs sshd + fake remote)");
  process.exit(0);
}

const CONFIG = process.argv[2] ?? "/tmp/herddeck-t9/config.toml";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const config = loadConfig(CONFIG);

// Give the remote session an agent to show: a throwaway workspace with
// an injected lifecycle state (the deterministic path from phase 0).
const remoteTarget = config.targets.find((t) => t.kind === "remote");
if (!remoteTarget || remoteTarget.kind !== "remote") fail("config has no remote target");
const remote = new HerdrClient(remoteTarget.remoteSocket);
const remoteWs = await remote.call<Record<string, unknown>>("workspace.create", {
  label: "t9",
  cwd: process.env.HOME,
});
const remotePane = (remoteWs.root_pane as Record<string, unknown>).pane_id as string;
const remoteWsId = (remoteWs.workspace as Record<string, unknown>).workspace_id as string;
await remote.call("pane.report_agent", {
  pane_id: remotePane,
  source: "custom:herddeck-t9",
  agent: "claude",
  state: "blocked",
  seq: 1,
});

const tunnels = new TunnelManager(ensureRunDir());
let focusCalls = 0;
const registry = new SessionRegistry(
  config,
  {
    targetsChanged: (targets) => server.broadcast({ type: "targets:update", targets }),
    agentsChanged: (agents) => server.broadcast({ type: "agents:update", agents }),
  },
  tunnels,
);
const server = new DeckServer({
  registry,
  version: "t9",
  focusTerminal: async () => {
    focusCalls++;
  },
  wispr: { start: () => {}, stop: () => {} },
});

server.start(config.port);
registry.start();

const received: Array<Record<string, unknown>> = [];
const ws = new WebSocket(`ws://127.0.0.1:${config.port}/ws`);
ws.onmessage = (m) => received.push(JSON.parse(String(m.data)));
await sleep(6000); // tunnel establish + probe + both snapshots

const targets = [...received].reverse().find((e) => e.type === "targets:update")?.targets as
  | Array<{ name: string; kind: string; state: string }>
  | undefined;
console.log("targets:", JSON.stringify(targets));
if (!targets?.every((t) => t.state === "online"))
  fail(`not all targets online: ${JSON.stringify(targets)}`);

const agents = ([...received].reverse().find((e) => e.type === "agents:update")?.agents ??
  []) as Array<{ target: string; paneId: string; status: string }>;
const byTarget = new Map<string, number>();
for (const a of agents) byTarget.set(a.target, (byTarget.get(a.target) ?? 0) + 1);
console.log("agents per target:", JSON.stringify([...byTarget]));
if (!byTarget.has("here")) fail("no agents from the local target");
if (!byTarget.has("fakebox")) fail("no agents from the remote target");

// Slot ordering must interleave by status, not clump by target.
const statuses = agents.map((a) => a.status);
const rank = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4, offline: 5 } as Record<
  string,
  number
>;
for (let i = 1; i < statuses.length; i++) {
  if ((rank[statuses[i - 1] ?? ""] ?? 9) > (rank[statuses[i] ?? ""] ?? 9)) {
    fail(`slot order not status-sorted across targets: ${statuses.join(",")}`);
  }
}

// Command routing: keys for a remote agent must reach the remote socket.
const remoteAgent = agents.find((a) => a.target === "fakebox");
if (!remoteAgent) fail("no remote agent to route to");
ws.send(
  JSON.stringify({
    type: "agent:keys",
    target: "fakebox",
    paneId: remoteAgent?.paneId,
    keys: ["enter"],
  }),
);
await sleep(600);

// focus_terminal now applies to remote targets too (default true).
ws.send(JSON.stringify({ type: "agent:focus", target: "fakebox", paneId: remoteAgent?.paneId }));
await sleep(600);
if (focusCalls < 1) fail("remote agent:focus did not foreground the terminal");

await remote.call("workspace.close", { workspace_id: remoteWsId });
console.log(
  `PASS T9: ${agents.length} slots merged from ${byTarget.size} targets, status-sorted, remote routing + focus OK`,
);
ws.close();
registry.stop();
server.stop();
process.exit(0);
