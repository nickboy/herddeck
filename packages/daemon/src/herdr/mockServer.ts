// In-process mock of herdr's NDJSON unix-socket API for tests.
//
// Mimics the live-verified connection model: one request per
// connection (first line answered, rest ignored, then close) except
// events.subscribe, which ACKs and holds the connection open as an
// event stream. Subscribe failures reply pre-ACK with a derived id
// ("<reqid>:sub:0:probe") and no ACK, matching herdr 0.8.0.

import fs from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { EXPECTED_PROTOCOL, LineDecoder, type SessionSnapshot } from "@herddeck/protocol";

/** Sentinel a handler returns to leave the request unanswered (timeout tests). */
export const NO_REPLY = Symbol("NO_REPLY");

export class MockApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MockApiError";
  }
}

export interface MockRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export class MockStream {
  clientClosed = false;
  readonly clientClose: Promise<void>;
  private resolveClose!: () => void;

  constructor(
    readonly subs: Array<Record<string, unknown>>,
    private readonly sock: Socket,
  ) {
    this.clientClose = new Promise((res) => {
      this.resolveClose = res;
    });
    sock.on("close", () => {
      this.clientClosed = true;
      this.resolveClose();
    });
  }

  /** Push an {event, data} envelope (post-ACK lines carry no id). */
  push(event: string, data: Record<string, unknown>): void {
    this.sock.write(`${JSON.stringify({ event, data })}\n`);
  }

  /** Server-side drop of the stream connection. */
  end(): void {
    this.sock.destroy();
  }

  subTypes(): string[] {
    return this.subs.map((s) => String(s.type));
  }

  paneIds(): string[] {
    return this.subs
      .map((s) => s.pane_id)
      .filter((v): v is string => typeof v === "string")
      .sort();
  }
}

type Handler = (params: Record<string, unknown>) => Record<string, unknown> | typeof NO_REPLY;

interface Waiter<T> {
  pred: (v: T) => boolean;
  resolve: (v: T) => void;
}

export function emptySnapshot(): SessionSnapshot {
  return {
    version: "0.8.0-mock",
    protocol: EXPECTED_PROTOCOL,
    workspaces: [],
    tabs: [],
    panes: [],
    layouts: [],
    agents: [],
  };
}

export class MockHerdr {
  protocol = EXPECTED_PROTOCOL;
  snapshot: SessionSnapshot = emptySnapshot();
  /** Non-null ⇒ events.subscribe fails pre-ACK with this error. */
  failSubscribe: { code: string; message: string } | null = null;
  /**
   * Non-null ⇒ command replies carry this id instead of the request's
   * (herdr answers malformed requests with id "" — correlation must be
   * "the single in-flight request", not id equality).
   */
  replyIdOverride: string | null = null;
  /** Per-method overrides; throw MockApiError for an error envelope. */
  handlers = new Map<string, Handler>();

  requests: MockRequest[] = [];
  streams: MockStream[] = [];
  connectionCount = 0;

  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private requestWaiters: Waiter<MockRequest>[] = [];
  private streamWaiters: Waiter<MockStream>[] = [];

  constructor(readonly socketPath: string) {}

  listen(): Promise<void> {
    fs.rmSync(this.socketPath, { force: true });
    const server = createServer((sock) => this.handleConnection(sock));
    this.server = server;
    return new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(this.socketPath, () => res());
    });
  }

  /** Stop accepting and drop all live connections; socket file removed. */
  async stop(): Promise<void> {
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((res) => server.close(() => res()));
    }
    fs.rmSync(this.socketPath, { force: true });
  }

  /** Resolve when a request for `method` arrives (past or future). */
  waitForRequest(method: string, after = 0): Promise<MockRequest> {
    const hit = this.requests.slice(after).find((r) => r.method === method);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      this.requestWaiters.push({ pred: (r) => r.method === method, resolve });
    });
  }

  /** Resolve when a stream matching pred opens (past or future). */
  waitForStream(pred: (s: MockStream) => boolean = () => true, after = 0): Promise<MockStream> {
    const hit = this.streams.slice(after).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      this.streamWaiters.push({ pred, resolve });
    });
  }

  private handleConnection(sock: Socket): void {
    this.connectionCount++;
    this.sockets.add(sock);
    sock.setEncoding("utf8");
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => {});

    const decoder = new LineDecoder();
    let answered = false;
    sock.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        // One request per connection: only the first line is answered.
        if (answered) continue;
        answered = true;
        this.handleRequest(line as Record<string, unknown>, sock);
      }
    });
  }

  private handleRequest(raw: Record<string, unknown>, sock: Socket): void {
    const req: MockRequest = {
      id: typeof raw.id === "string" ? raw.id : "",
      method: typeof raw.method === "string" ? raw.method : "",
      params: (raw.params as Record<string, unknown>) ?? {},
    };
    this.requests.push(req);
    for (let i = this.requestWaiters.length - 1; i >= 0; i--) {
      const waiter = this.requestWaiters[i];
      if (waiter?.pred(req)) {
        this.requestWaiters.splice(i, 1);
        waiter.resolve(req);
      }
    }

    const reply = (obj: Record<string, unknown>) => {
      sock.write(`${JSON.stringify(obj)}\n`);
    };

    if (req.method === "events.subscribe") {
      if (this.failSubscribe) {
        // Derived-id error, no ACK — the whole batch fails.
        reply({ id: `${req.id}:sub:0:probe`, error: this.failSubscribe });
        sock.end();
        return;
      }
      const subs = (req.params.subscriptions as Array<Record<string, unknown>>) ?? [];
      const stream = new MockStream(subs, sock);
      this.streams.push(stream);
      reply({ id: req.id, result: { type: "subscription_started" } });
      for (let i = this.streamWaiters.length - 1; i >= 0; i--) {
        const waiter = this.streamWaiters[i];
        if (waiter?.pred(stream)) {
          this.streamWaiters.splice(i, 1);
          waiter.resolve(stream);
        }
      }
      return; // connection stays open as the event stream
    }

    const custom = this.handlers.get(req.method);
    try {
      let result: Record<string, unknown>;
      if (custom) {
        const out = custom(req.params);
        if (out === NO_REPLY) return; // hold the connection open, never answer
        result = out;
      } else if (req.method === "ping") {
        result = {
          type: "pong",
          version: "0.8.0-mock",
          protocol: this.protocol,
          capabilities: {},
        };
      } else if (req.method === "session.snapshot") {
        result = { snapshot: this.snapshot as unknown as Record<string, unknown> };
      } else {
        throw new MockApiError("unknown_method", `no handler for ${req.method}`);
      }
      reply({ id: this.replyIdOverride ?? req.id, result });
    } catch (err) {
      const e = err instanceof MockApiError ? err : new MockApiError("internal_error", String(err));
      reply({ id: this.replyIdOverride ?? req.id, error: { code: e.code, message: e.message } });
    }
    sock.end();
  }
}
