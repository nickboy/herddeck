import { EventEmitter } from "node:events";
import type { WsCommand, WsEvent } from "./wire";

export type BridgeState = "disconnected" | "connecting" | "connected";

export interface BridgeClientOptions {
  url?: string;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable for tests. Defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

interface SocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  send(data: string): void;
  close?(): void;
}

type SocketCtor = new (url: string) => SocketLike;

/**
 * WebSocket client that stays subscribed to the daemon's event stream,
 * reconnects with exponential backoff (jittered), and queues outbound
 * commands while disconnected. Ported from claudedeck's
 * `plugin/src/bridgeClient.ts` — reconnect/backoff behaviour is
 * unchanged, only the wire types and default URL differ (daemon
 * listens on ws://127.0.0.1:9137/ws per `docs/CONTRACTS.md`, vs
 * claudedeck's 9127). Emits:
 *
 *   - "state" (BridgeState)  whenever connection state changes
 *   - "event" (WsEvent)      for every JSON message parsed from the daemon
 */
export class BridgeClient extends EventEmitter {
  state: BridgeState = "disconnected";

  private readonly url: string;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly WebSocketImpl: SocketCtor;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private socket: SocketLike | null = null;
  private stopped = true;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private outbound: string[] = [];

  constructor(opts: BridgeClientOptions = {}) {
    super();
    this.url = opts.url ?? "ws://127.0.0.1:9137/ws";
    this.initialBackoffMs = opts.initialBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.WebSocketImpl = (opts.WebSocketImpl ??
      ((globalThis as { WebSocket?: unknown }).WebSocket as unknown)) as SocketCtor;
    this.setTimeoutFn = opts.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutImpl ?? clearTimeout;
    this.backoffMs = this.initialBackoffMs;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close?.();
    this.socket = null;
    this.setState("disconnected");
  }

  /**
   * Serialise and send a command to the daemon.
   *
   * @returns `true` when the command went out on the live socket
   * immediately, `false` when the bridge was disconnected and the
   * command was queued for the next reconnect.
   *
   * Callers that need user-facing feedback (e.g. the Stream Deck
   * answer keys) MUST branch on this: `true` → show success; `false`
   * → show failure / don't fake a confirmation. Ported from
   * claudedeck, which learned this the hard way (silently queuing
   * flashed the Stream Deck's "ok" checkmark for presses that never
   * reached the daemon).
   */
  send(cmd: WsCommand): boolean {
    const serialised = JSON.stringify(cmd);
    if (this.state === "connected" && this.socket) {
      this.socket.send(serialised);
      return true;
    }
    this.outbound.push(serialised);
    return false;
  }

  private connect(): void {
    this.setState("connecting");
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.setState("connected");
      this.backoffMs = this.initialBackoffMs;
      for (const line of this.outbound) socket.send(line);
      this.outbound = [];
    };

    socket.onmessage = (e: { data: string }) => {
      try {
        const parsed = JSON.parse(e.data) as WsEvent;
        this.emit("event", parsed);
      } catch {
        // Malformed JSON — drop. Daemon never sends junk, so this is defensive.
      }
    };

    socket.onclose = () => {
      this.socket = null;
      if (this.stopped) {
        this.setState("disconnected");
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // Errors generally also produce a close event; suppressing here keeps
      // the caller side clean. Caller can still observe via state=disconnected.
    };
  }

  private scheduleReconnect(): void {
    this.setState("disconnected");
    const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20%
    const delay = Math.min(this.maxBackoffMs, this.backoffMs) * jitter;
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
    this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2);
  }

  private setState(next: BridgeState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit("state", next);
  }
}
