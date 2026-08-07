// Transport for herdr's NDJSON unix-socket API.
//
// The socket is ONE REQUEST PER CONNECTION (verified live, see
// docs/plans/2026-08-06-phase-0-results.md): the server answers the first
// NDJSON line, ignores the rest, and closes. call() therefore opens a
// fresh connection per request. events.subscribe instead converts its
// connection into a long-lived event stream whose subscription set is
// fixed at open — changing it means opening a new stream connection.

import { randomUUID } from "node:crypto";
import { type Socket, connect } from "node:net";
import {
  type HerdrEventEnvelope,
  type HerdrResponse,
  LineDecoder,
  type Subscription,
  encodeRequest,
} from "@herddeck/protocol";

const ACK_TIMEOUT_MS = 5000;

export class HerdrApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrApiError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export interface StreamHandlers {
  onEvent(e: HerdrEventEnvelope): void;
  onClose(err?: Error): void;
}

export interface StreamHandle {
  close(): void;
}

function isResponse(line: unknown): line is HerdrResponse {
  return typeof line === "object" && line !== null && ("result" in line || "error" in line);
}

function isEventEnvelope(line: unknown): line is HerdrEventEnvelope {
  return (
    typeof line === "object" &&
    line !== null &&
    "event" in line &&
    typeof (line as { event: unknown }).event === "string"
  );
}

export class HerdrClient {
  constructor(private readonly socketPath: string) {}

  /**
   * One-shot request on a fresh connection. Correlation is "the single
   * in-flight request on this connection", never id equality: malformed
   * requests come back with id "" and error ids can be derived
   * ("<reqid>:sub:<idx>:probe"), so the first response line settles the
   * call regardless of its id.
   */
  call<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    timeoutMs = 8000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const sock = connect(this.socketPath);
      sock.setEncoding("utf8");
      const decoder = new LineDecoder();
      let settled = false;

      const timer = setTimeout(() => {
        settle(() => reject(new TimeoutError(`${method} timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      };

      sock.on("connect", () => {
        sock.write(encodeRequest(randomUUID(), method, params ?? {}));
      });
      sock.on("data", (chunk: string) => {
        for (const line of decoder.push(chunk)) {
          if (!isResponse(line)) continue;
          if (line.error) {
            const { code, message } = line.error;
            settle(() => reject(new HerdrApiError(code, message)));
          } else {
            settle(() => resolve(line.result as T));
          }
          return;
        }
      });
      sock.on("error", (err) => settle(() => reject(err)));
      sock.on("close", () => {
        settle(() => reject(new Error(`connection closed before ${method} response`)));
      });
    });
  }

  /**
   * Open an events.subscribe stream. Resolves only after the
   * subscription_started ACK. Any response line before the ACK is a
   * subscribe failure (one invalid subscription fails the whole batch
   * with a derived id and no ACK) and rejects. After close() the
   * onClose handler is never invoked — deliberate closes are silent so
   * callers doing make-before-break don't treat them as failures.
   */
  openStream(subscriptions: Subscription[], handlers: StreamHandlers): Promise<StreamHandle> {
    return new Promise<StreamHandle>((resolve, reject) => {
      const sock: Socket = connect(this.socketPath);
      sock.setEncoding("utf8");
      const decoder = new LineDecoder();
      let acked = false;
      let done = false; // stream fully finished (pre-ACK failure or closed)
      let deliberateClose = false;

      const ackTimer = setTimeout(() => {
        failPreAck(new TimeoutError(`events.subscribe ACK timed out after ${ACK_TIMEOUT_MS}ms`));
      }, ACK_TIMEOUT_MS);

      const failPreAck = (err: Error) => {
        if (acked || done) return;
        done = true;
        clearTimeout(ackTimer);
        sock.destroy();
        reject(err);
      };

      sock.on("connect", () => {
        sock.write(encodeRequest(randomUUID(), "events.subscribe", { subscriptions }));
      });
      sock.on("data", (chunk: string) => {
        for (const line of decoder.push(chunk)) {
          if (!acked) {
            if (isResponse(line) && line.error) {
              failPreAck(new HerdrApiError(line.error.code, line.error.message));
              return;
            }
            if (isResponse(line)) {
              acked = true;
              clearTimeout(ackTimer);
              resolve({
                close() {
                  deliberateClose = true;
                  done = true;
                  sock.destroy();
                },
              });
            }
            continue;
          }
          if (isEventEnvelope(line)) handlers.onEvent(line);
        }
      });
      sock.on("error", (err) => {
        if (!acked) {
          failPreAck(err);
          return;
        }
        if (done || deliberateClose) return;
        done = true;
        handlers.onClose(err);
      });
      sock.on("close", () => {
        if (!acked) {
          failPreAck(new Error("connection closed before subscription ACK"));
          return;
        }
        if (done || deliberateClose) return;
        done = true;
        handlers.onClose();
      });
    });
  }
}
