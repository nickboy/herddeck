// Live integration smoke against the herddeck-test named session.
// Run: bun packages/daemon/test/integration/live-smoke.ts
// Requires: `herdr --session herddeck-test server` running.
// Never touches the default session. Cleans up its workspace.

import { TargetMonitor, type TargetState } from "../../src/herdr/monitor.ts";
import { HerdrClient } from "../../src/herdr/client.ts";

const SOCKET = `${process.env.HOME}/.config/herdr/sessions/herddeck-test/herdr.sock`;
const SOURCE = "custom:herddeck-live-smoke";

const states: Array<{ state: TargetState; protocol: number | null }> = [];
const agentLog: string[] = [];

const monitor = new TargetMonitor(
  "test",
  SOCKET,
  {
    status: (state, protocol) => {
      states.push({ state, protocol });
      console.log(`[status] ${state} protocol=${protocol}`);
    },
    agentsChanged: (agents) => {
      const line = agents.map((a) => `${a.paneId}:${a.agentKind}:${a.status}`).join(" ") || "(none)";
      agentLog.push(line);
      console.log(`[agents] ${line}`);
    },
  },
  { backoffMs: [300, 2000] },
);

const direct = new HerdrClient(SOCKET);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

monitor.start();
await sleep(1500);
if (!states.some((s) => s.state === "online")) fail("never went online");

// Create a throwaway workspace; monitor must pick up the pane via events.
const ws = await direct.call<Record<string, unknown>>("workspace.create", {
  label: "live-smoke",
  cwd: process.env.HOME,
});
const paneId = (ws.root_pane as Record<string, unknown>).pane_id as string;
const wsId = (ws.workspace as Record<string, unknown>).workspace_id as string;
console.log(`>>> pane ${paneId} in workspace ${wsId}`);
await sleep(800);

// Inject agent lifecycle; monitor must emit each transition.
for (const [seq, state] of [
  [1, "working"],
  [2, "blocked"],
  [3, "idle"],
] as const) {
  await direct.call("pane.report_agent", {
    pane_id: paneId,
    source: SOURCE,
    agent: "claude",
    state,
    seq,
  });
  await sleep(400);
}
const sawBlocked = agentLog.some((l) => l.includes(`${paneId}:claude:blocked`));
const sawIdle = agentLog.some((l) => l.includes(`${paneId}:claude:idle`));
if (!sawBlocked || !sawIdle) fail(`missing transitions (blocked=${sawBlocked} idle=${sawIdle})`);

// Command path: answer keys through the monitor's call surface.
await monitor.call("pane.send_keys", { pane_id: paneId, keys: ["1", "enter"] });
await sleep(300);

// Teardown workspace; monitor must drop the agent. workspace.close
// completes asynchronously server-side (pane processes wind down
// first) and emits workspace_closed WITHOUT per-pane events.
await direct.call("workspace.close", { workspace_id: wsId });
await sleep(2500);
const last = agentLog[agentLog.length - 1];
if (last !== "(none)") fail(`agent not removed after workspace.close (last: ${last})`);

console.log("PASS: online, event flow, injection transitions, cleanup all verified");
console.log(
  "NOTE: kill/restart recovery is exercised by scripts/live-recovery.sh (separate step)",
);
monitor.stop();
process.exit(0);
