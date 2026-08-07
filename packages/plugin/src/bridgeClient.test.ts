import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BridgeClient } from "./bridgeClient";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  // Test helpers to simulate peer behaviour:
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  errorOut(e: unknown): void {
    this.onerror?.(e);
  }

  // Standard WS API
  send(s: string): void {
    this.sent.push(s);
  }
}

let client: BridgeClient;
let timeouts: Array<{ cb: () => void; ms: number }>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  timeouts = [];
});

afterEach(() => {
  client?.stop();
});

function makeClient(override: Partial<ConstructorParameters<typeof BridgeClient>[0]> = {}) {
  return new BridgeClient({
    url: "ws://test",
    initialBackoffMs: 10,
    maxBackoffMs: 100,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    setTimeoutImpl: ((cb: () => void, ms: number) => {
      const entry = { cb, ms };
      timeouts.push(entry);
      return entry as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimeoutImpl: ((t: unknown) => {
      timeouts = timeouts.filter((e) => e !== t);
    }) as typeof clearTimeout,
    ...override,
  });
}

const latestSocket = () => FakeWebSocket.instances.at(-1);

describe("BridgeClient defaults", () => {
  test("defaults to the v2 daemon WS URL (127.0.0.1:9137)", () => {
    client = new BridgeClient({ WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket });
    client.start();
    expect(latestSocket()?.url).toBe("ws://127.0.0.1:9137/ws");
  });
});

describe("BridgeClient lifecycle", () => {
  test("start opens a WebSocket to the configured URL", () => {
    client = makeClient();
    client.start();
    expect(latestSocket()?.url).toBe("ws://test");
    expect(client.state).toBe("connecting");
  });

  test("connected state after socket opens", () => {
    client = makeClient();
    client.start();
    latestSocket()?.open();
    expect(client.state).toBe("connected");
  });

  test("emits state events on transitions", () => {
    client = makeClient();
    const states: string[] = [];
    client.on("state", (s: string) => states.push(s));
    client.start();
    latestSocket()?.open();
    expect(states).toEqual(["connecting", "connected"]);
  });

  test("stop closes socket and transitions to disconnected", () => {
    client = makeClient();
    client.start();
    latestSocket()?.open();
    client.stop();
    expect(client.state).toBe("disconnected");
  });
});

describe("BridgeClient message handling", () => {
  test("parses JSON messages and emits event", () => {
    client = makeClient();
    const events: unknown[] = [];
    client.on("event", (e) => events.push(e));
    client.start();
    latestSocket()?.open();
    latestSocket()?.message({ type: "daemon:ready", version: "test" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "daemon:ready", version: "test" });
  });

  test("ignores malformed JSON (no crash)", () => {
    client = makeClient();
    const events: unknown[] = [];
    client.on("event", (e) => events.push(e));
    client.start();
    latestSocket()?.open();
    latestSocket()?.message("not json");
    expect(events).toHaveLength(0);
  });

  test("parses a v2 agents:update event", () => {
    client = makeClient();
    const events: unknown[] = [];
    client.on("event", (e) => events.push(e));
    client.start();
    latestSocket()?.open();
    latestSocket()?.message({
      type: "agents:update",
      agents: [
        {
          target: "local",
          paneId: "p1",
          name: null,
          agentKind: "claude",
          status: "working",
          workspaceLabel: null,
          cwd: "/tmp/x",
          title: null,
          ctxPct: 12,
          stateChangeSeq: 1,
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "agents:update" });
  });

  test("send serialises and writes to socket when connected", () => {
    client = makeClient();
    client.start();
    latestSocket()?.open();
    client.send({ type: "agent:focus", target: "local", paneId: "p1" });
    expect(latestSocket()?.sent).toEqual([
      JSON.stringify({ type: "agent:focus", target: "local", paneId: "p1" }),
    ]);
  });

  test("send returns true when connected", () => {
    client = makeClient();
    client.start();
    latestSocket()?.open();
    const sent = client.send({ type: "agent:focus", target: "local", paneId: "p1" });
    expect(sent).toBe(true);
  });

  test("send when disconnected queues the command and flushes on open", () => {
    client = makeClient();
    client.start();
    // not open yet — command should be queued
    client.send({ type: "agent:focus", target: "local", paneId: "p1" });
    expect(latestSocket()?.sent).toHaveLength(0);
    latestSocket()?.open();
    expect(latestSocket()?.sent).toHaveLength(1);
  });

  test("send returns false when disconnected (command is queued, not transmitted)", () => {
    client = makeClient();
    client.start();
    // socket is in "connecting" state, not "connected"
    const sent = client.send({ type: "agent:focus", target: "local", paneId: "p1" });
    expect(sent).toBe(false);
    // verify the command was queued for later flush
    expect(latestSocket()?.sent).toHaveLength(0);
  });
});

describe("BridgeClient reconnect with exponential backoff", () => {
  test("schedules reconnect after close", () => {
    client = makeClient();
    client.start();
    latestSocket()?.open();
    latestSocket()?.close();
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.ms).toBeGreaterThanOrEqual(8); // 10ms ± jitter
  });

  test("backoff doubles up to maxBackoffMs", () => {
    client = makeClient({ initialBackoffMs: 10, maxBackoffMs: 40 });
    client.start();

    // Simulate 5 failed reconnects
    for (let i = 0; i < 5; i++) {
      latestSocket()?.open();
      latestSocket()?.close();
      timeouts[0]?.cb();
      timeouts.shift();
    }

    // The final scheduled backoff should not exceed maxBackoffMs * 1.2 (jitter).
    latestSocket()?.open();
    latestSocket()?.close();
    const lastMs = timeouts.at(-1)?.ms ?? 0;
    expect(lastMs).toBeLessThanOrEqual(48);
  });

  test("successful open resets backoff", () => {
    client = makeClient({ initialBackoffMs: 10 });
    client.start();
    latestSocket()?.open();
    latestSocket()?.close();
    const firstBackoff = timeouts[0]?.ms ?? 0;
    timeouts[0]?.cb();
    timeouts.shift();
    latestSocket()?.open(); // reconnected successfully
    latestSocket()?.close(); // and closed again
    const secondBackoff = timeouts[0]?.ms ?? 0;
    // second backoff should be close to first (within jitter), not doubled
    expect(secondBackoff).toBeLessThanOrEqual(firstBackoff * 1.5);
  });

  test("stop cancels any pending reconnect timer", () => {
    client = makeClient();
    client.start();
    latestSocket()?.open();
    latestSocket()?.close();
    expect(timeouts).toHaveLength(1);
    client.stop();
    expect(timeouts).toHaveLength(0);
  });
});
