// Phase 0 live spike against a herdr named test session.
//
// Usage: bun packages/protocol/spike/phase0.ts [socket-path]
// Default socket: ~/.config/herdr/sessions/herddeck-test/herdr.sock
//
// Exercises every Phase 0 verification item from docs/plans/2026-08-06-master-plan.md
// and prints an OBSERVED/ERROR block per item. Never touches the default session.
//
// Protocol facts discovered live (herdr 0.8.0, protocol 19):
//   - The API socket is ONE REQUEST PER CONNECTION: the server answers the
//     first NDJSON line, ignores the rest, and closes. Commands therefore
//     open a fresh connection per call.
//   - events.subscribe converts its connection into a long-lived event
//     stream; the subscription set is fixed at open. Changing subscriptions
//     means opening a new stream connection (make-before-break).
//   - pane.agent_status_changed / pane.output_matched subscriptions are
//     per-pane (pane_id required; "*" → pane_not_found). Lifecycle events
//     (pane.created/closed/moved, pane.agent_detected) are global.
//   - One invalid subscription fails the whole subscribe request with a
//     derived-id error like "<reqid>:sub:<index>:probe" and no ACK.
//   - Malformed requests error with id "".

import { type Socket, connect } from "node:net";

const SOCKET =
  process.argv[2] ?? `${process.env.HOME}/.config/herdr/sessions/herddeck-test/herdr.sock`;
const SOURCE = "custom:herddeck-test";

type Json = Record<string, unknown>;

function ndjsonReader(sock: Socket, onLine: (msg: Json) => void) {
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) onLine(JSON.parse(line) as Json);
    }
  });
}

// One connection per command call — matches the server's model.
function call(method: string, params: Json = {}, timeoutMs = 8000): Promise<Json> {
  return new Promise((res, rej) => {
    const sock = connect(SOCKET);
    const t = setTimeout(() => {
      sock.destroy();
      rej(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    ndjsonReader(sock, (msg) => {
      clearTimeout(t);
      sock.end();
      res(msg);
    });
    sock.on("error", (e) => {
      clearTimeout(t);
      rej(e);
    });
    sock.on("connect", () =>
      sock.write(`${JSON.stringify({ id: `spike-${method}`, method, params })}\n`),
    );
  });
}

// Long-lived event stream: one connection whose subscription set is fixed.
class EventStream {
  readonly events: Json[] = [];
  private waiters: Array<(e: Json) => boolean> = [];
  private sock: Socket;
  private ackResolve!: (msg: Json) => void;
  readonly ack: Promise<Json>;
  private acked = false;

  constructor(subscriptions: Json[]) {
    this.ack = new Promise((res) => {
      this.ackResolve = res;
    });
    this.sock = connect(SOCKET);
    ndjsonReader(this.sock, (msg) => {
      if (!this.acked) {
        this.acked = true;
        this.ackResolve(msg);
        return;
      }
      this.events.push(msg);
      this.waiters = this.waiters.filter((w) => !w(msg));
    });
    this.sock.on("connect", () =>
      this.sock.write(
        `${JSON.stringify({ id: "spike-events", method: "events.subscribe", params: { subscriptions } })}\n`,
      ),
    );
  }

  waitEvent(pred: (e: Json) => boolean, timeoutMs = 8000): Promise<Json | null> {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res) => {
      const t = setTimeout(() => res(null), timeoutMs);
      this.waiters.push((e) => {
        if (!pred(e)) return false;
        clearTimeout(t);
        res(e);
        return true;
      });
    });
  }

  close() {
    this.sock.end();
  }
}

const show = (label: string, v: unknown) =>
  console.log(`\n### ${label}\n${JSON.stringify(v, null, 2)}`);

// ── 1. ping: protocol handshake ────────────────────────────────────
show("ping", await call("ping"));

// ── 2. global lifecycle stream FIRST (race-free ordering) ──────────
const lifecycle = new EventStream([
  { type: "pane.created" },
  { type: "pane.agent_detected" },
  { type: "pane.closed" },
  { type: "pane.moved" },
]);
show("events.subscribe (global lifecycle) ACK", await lifecycle.ack);

// ── 3. snapshot shape ──────────────────────────────────────────────
const snap = await call("session.snapshot");
show("session.snapshot (result keys)", {
  resultKeys: Object.keys((snap.result as Json) ?? {}),
  snapshotKeys: Object.keys(((snap.result as Json)?.snapshot as Json) ?? {}),
});

// ── 4. workspace + pane to play with ───────────────────────────────
const ws = await call("workspace.create", { label: "spike", cwd: process.env.HOME });
show("workspace.create", ws.result ?? ws);
const wsResult = (ws.result as Json) ?? {};
const paneId = ((wsResult.root_pane as Json)?.pane_id ??
  (wsResult.pane as Json)?.pane_id) as string;
console.log(`\n>>> pane under test: ${paneId}`);

show(
  "pane.created event (raw envelope)",
  await lifecycle.waitEvent((e) => JSON.stringify(e).includes("pane_created"), 4000),
);

// ── 5. per-pane stream: agent_status_changed + output_matched ──────
const paneStream = new EventStream([
  { type: "pane.agent_status_changed", pane_id: paneId },
  {
    type: "pane.output_matched",
    pane_id: paneId,
    source: "visible",
    match: { type: "substring", value: "HERDDECK_MENU_PROBE" },
  },
]);
show("events.subscribe (per-pane) ACK", await paneStream.ack);

await call("pane.send_text", { pane_id: paneId, text: "echo HERDDECK_MENU_PROBE" });
await call("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
show(
  "pane.output_matched fired?",
  await paneStream.waitEvent((e) => JSON.stringify(e).includes("output_matched"), 8000),
);

// ── 6. report_agent injection: working → blocked, watch events ─────
show(
  "pane.report_agent (inject working)",
  await call("pane.report_agent", {
    pane_id: paneId,
    source: SOURCE,
    agent: "claude",
    state: "working",
    seq: 1,
  }),
);
const agentsAfterInject = await call("agent.list");
show("agent.list after injection", agentsAfterInject.result ?? agentsAfterInject);

await call("pane.report_agent", {
  pane_id: paneId,
  source: SOURCE,
  agent: "claude",
  state: "blocked",
  message: "Do you want to proceed?",
  seq: 2,
});
show(
  "agent_status_changed event (blocked)",
  await paneStream.waitEvent((e) => JSON.stringify(e).includes("blocked"), 6000),
);

// ── 7. agent.explain on the blocked (injected) agent ───────────────
show("agent.explain (blocked)", await call("agent.explain", { target: paneId }));

// ── 8. agent surface targeting: pane id vs name ────────────────────
// Finding: agent.send_keys refuses INJECTED agents ("agent_not_ready" —
// it requires a real interactive-ready agent). Real agents in production
// will pass; for injected test agents the pane surface is the fallback.
show(
  "agent.send_keys target=pane_id (expect agent_not_ready for injected)",
  await call("agent.send_keys", { target: paneId, keys: ["1"] }),
);
show("agent.rename", await call("agent.rename", { target: paneId, name: "spiky" }));
show(
  "agent.send_keys target=name (expect agent_not_ready for injected)",
  await call("agent.send_keys", { target: "spiky", keys: ["2", "enter"] }),
);
show(
  "agent.get target=name (name resolution works for non-mutating calls?)",
  (await call("agent.get", { target: "spiky" })).result ?? "see raw",
);
await call("pane.send_keys", { pane_id: paneId, keys: ["1", "2", "enter"] });
const read = await call("agent.read", { target: paneId, source: "visible", lines: 6 });
show("agent.read visible tail (did pane.send_keys land?)", read.result ?? read);

// ── 9. done semantics: inject idle on unfocused pane ───────────────
await call("pane.report_agent", {
  pane_id: paneId,
  source: SOURCE,
  agent: "claude",
  state: "idle",
  seq: 3,
});
await new Promise((r) => setTimeout(r, 500));
const listIdle = await call("agent.list");
const mine = ((listIdle.result as Json)?.agents as Json[] | undefined)?.find(
  (a) => a.pane_id === paneId,
);
show("agent_status after injected idle (expect done if unseen)", mine ?? listIdle.result);

show("agent.focus", await call("agent.focus", { target: paneId }));
await new Promise((r) => setTimeout(r, 500));
const got = await call("agent.get", { target: paneId });
show("agent.get after focus (expect idle once seen)", got.result ?? got);

// ── 10. cleanup: clear authority, verify pane clean, close up ──────
show(
  "pane.clear_agent_authority",
  await call("pane.clear_agent_authority", { pane_id: paneId, source: SOURCE }),
);
const listCleared = await call("agent.list");
show(
  "agent.list after clear (expect our pane agentless)",
  ((listCleared.result as Json)?.agents as Json[] | undefined)?.filter(
    (a) => a.pane_id === paneId,
  ) ?? listCleared.result,
);
const wsId = (wsResult.workspace as Json)?.id as string;
show("workspace.close", await call("workspace.close", { workspace_id: wsId }));

console.log(`\n### lifecycle stream events: ${lifecycle.events.length}`);
console.log(`### per-pane stream events: ${paneStream.events.length}`);
show("last 3 raw per-pane event envelopes (wire shape)", paneStream.events.slice(-3));

lifecycle.close();
paneStream.close();
