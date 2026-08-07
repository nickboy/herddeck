import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HerdrEventEnvelope, PongResult } from "@herddeck/protocol";
import { HerdrApiError, HerdrClient, TimeoutError } from "./client.ts";
import { MockApiError, MockHerdr, NO_REPLY } from "./mockServer.ts";

// Unix socket paths are capped (~104 bytes on macOS), so sockets live
// in a short mkdtemp dir rather than the session scratchpad.
let dir: string;
let sockPath: string;
let mock: MockHerdr;
let client: HerdrClient;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "herddeck-client-"));
  sockPath = path.join(dir, "herdr.sock");
  mock = new MockHerdr(sockPath);
  await mock.listen();
  client = new HerdrClient(sockPath);
});

afterEach(async () => {
  await mock.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("call", () => {
  test("resolves the result envelope", async () => {
    const pong = await client.call<PongResult>("ping");
    expect(pong.type).toBe("pong");
    expect(pong.protocol).toBe(19);
    expect(mock.requests[0]?.method).toBe("ping");
  });

  test("opens a fresh connection per request (one request per connection)", async () => {
    await client.call("ping");
    await client.call("ping");
    expect(mock.connectionCount).toBe(2);
  });

  test("throws HerdrApiError with the server's code on error envelope", async () => {
    mock.handlers.set("pane.focus", () => {
      throw new MockApiError("pane_not_found", "no such pane");
    });
    const err = await client.call("pane.focus", { pane_id: "ghost" }).catch((e) => e);
    expect(err).toBeInstanceOf(HerdrApiError);
    expect((err as HerdrApiError).code).toBe("pane_not_found");
    expect((err as HerdrApiError).message).toBe("no such pane");
  });

  test('correlates by "single in-flight request", not id equality', async () => {
    // herdr answers malformed requests with id "" — the reply must
    // still settle the call.
    mock.replyIdOverride = "";
    const pong = await client.call<PongResult>("ping");
    expect(pong.type).toBe("pong");
  });

  test("times out with TimeoutError when the server never replies", async () => {
    mock.handlers.set("ping", () => NO_REPLY);
    const err = await client.call("ping", {}, 60).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
  });

  test("propagates connect errors for an absent socket", async () => {
    const gone = new HerdrClient(path.join(dir, "absent.sock"));
    const err = await gone.call("ping").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toMatch(/ENOENT|ECONNREFUSED/);
  });
});

describe("openStream", () => {
  test("resolves after the subscription_started ACK", async () => {
    const handle = await client.openStream([{ type: "pane.created" }], {
      onEvent: () => {},
      onClose: () => {},
    });
    expect(mock.streams).toHaveLength(1);
    expect(mock.streams[0]?.subTypes()).toEqual(["pane.created"]);
    handle.close();
  });

  test("rejects on a pre-ACK error line (derived id, no ACK)", async () => {
    mock.failSubscribe = { code: "pane_not_found", message: "pane ghost not found" };
    const err = await client
      .openStream([{ type: "pane.agent_status_changed", pane_id: "ghost" }], {
        onEvent: () => {},
        onClose: () => {},
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HerdrApiError);
    expect((err as HerdrApiError).code).toBe("pane_not_found");
  });

  test("rejects on connect error", async () => {
    const gone = new HerdrClient(path.join(dir, "absent.sock"));
    const err = await gone
      .openStream([{ type: "pane.created" }], { onEvent: () => {}, onClose: () => {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toMatch(/ENOENT|ECONNREFUSED/);
  });

  test("delivers pushed {event, data} envelopes to onEvent", async () => {
    const received: HerdrEventEnvelope[] = [];
    let resolveTwo!: () => void;
    const gotTwo = new Promise<void>((res) => {
      resolveTwo = res;
    });
    const handle = await client.openStream([{ type: "pane.created" }], {
      onEvent: (e) => {
        received.push(e);
        if (received.length === 2) resolveTwo();
      },
      onClose: () => {},
    });

    const stream = mock.streams[0];
    if (!stream) throw new Error("stream not registered");
    stream.push("pane_created", { type: "pane_created", pane_id: "p1" });
    stream.push("pane.agent_status_changed", { pane_id: "p1", agent_status: "working" });
    await gotTwo;

    expect(received[0]?.event).toBe("pane_created");
    expect(received[0]?.data.pane_id).toBe("p1");
    expect(received[1]?.event).toBe("pane.agent_status_changed");
    handle.close();
  });

  test("fires onClose when the server drops the stream", async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((res) => {
      resolveClosed = res;
    });
    await client.openStream([{ type: "pane.created" }], {
      onEvent: () => {},
      onClose: () => resolveClosed(),
    });
    mock.streams[0]?.end();
    await closed;
  });

  test("close() is silent — no onClose for deliberate closes", async () => {
    let closes = 0;
    const handle = await client.openStream([{ type: "pane.created" }], {
      onEvent: () => {},
      onClose: () => {
        closes++;
      },
    });
    handle.close();
    await mock.streams[0]?.clientClose;
    // Give any stray onClose a chance to fire before asserting.
    await new Promise((res) => setTimeout(res, 20));
    expect(closes).toBe(0);
  });
});
