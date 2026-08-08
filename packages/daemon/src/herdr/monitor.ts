// TargetMonitor: owns the connect lifecycle for one herdr target.
//
// Race-free startup/reconnect ordering (verified live, see
// docs/plans/2026-08-06-phase-0-results.md):
//   1. ping — protocol check (mismatch ⇒ warn state, still usable)
//   2. open global lifecycle stream, buffering events
//   3. session.snapshot → seed StateCache
//   4. replay buffered events with { replay: true } (stale ones dropped)
//   5. open per-pane status stream; reopen make-before-break whenever
//      the pane set changes (overlap duplicates are idempotent in the
//      cache, so double-delivery is harmless)
//
// Never spawns or stops herdr. ECONNREFUSED/ENOENT ⇒ offline; capped
// exponential backoff with jitter. Any stream close ⇒ full reconnect.

import {
  EXPECTED_PROTOCOL,
  type HerdrEventEnvelope,
  type PongResult,
  type SessionSnapshot,
  type Subscription,
} from "@herddeck/protocol";
import { type CachedAgent, StateCache } from "../stateCache.ts";
import { HerdrApiError, HerdrClient, type StreamHandle } from "./client.ts";

export type TargetState = "connecting" | "online" | "offline" | "protocol-mismatch";

/** Bound on per-open prune retries, so a pathological server can't spin
 * this loop forever. */
const MAX_STALE_PANE_PRUNES = 8;

/** herdr reports a bad subscription as `pane <id> not found`; pull the
 * id back out so we can drop exactly that pane. */
function stalePaneId(err: unknown): string | null {
  if (!(err instanceof HerdrApiError) || err.code !== "pane_not_found") return null;
  return /pane (\S+) not found/.exec(err.message)?.[1] ?? null;
}

export interface TargetMonitorEvents {
  status(state: TargetState, protocol: number | null): void;
  agentsChanged(agents: CachedAgent[]): void;
}

// workspace.closed / tab.closed matter because herdr does NOT emit
// per-pane pane_closed events when a workspace or tab close cascades
// (verified live) — the cache removes those panes from the container
// event instead.
const LIFECYCLE_SUBS: Subscription[] = [
  { type: "pane.created" },
  { type: "pane.closed" },
  { type: "pane.moved" },
  { type: "pane.agent_detected" },
  { type: "workspace.created" },
  { type: "workspace.renamed" },
  { type: "workspace.closed" },
  { type: "tab.created" },
  { type: "tab.renamed" },
  { type: "tab.closed" },
];

export class TargetMonitor {
  readonly cache = new StateCache();

  private readonly client: HerdrClient;
  private readonly backoffMin: number;
  private readonly backoffMax: number;

  private running = false;
  // Bumped on every stop/reconnect; stale async callbacks compare
  // against it and bail instead of touching torn-down state.
  private generation = 0;
  private backoffMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private lifecycleStream: StreamHandle | null = null;
  private paneStream: StreamHandle | null = null;
  private paneStreamKey = "";
  private paneStreamReopening = false;

  // agentsChanged debounce: queueMicrotask. One socket data chunk can
  // carry many NDJSON events, all parsed in one macrotask — a microtask
  // coalesces that whole burst into one emission with zero added
  // latency. (A 10ms timer would also merge cross-chunk bursts but
  // delays every update; bursts across chunks are rare enough that the
  // extra emissions are cheap.)
  private agentsEmitPending = false;

  constructor(
    readonly name: string,
    socketPath: string,
    private readonly events: TargetMonitorEvents,
    opts?: { backoffMs?: [min: number, max: number] },
  ) {
    this.client = new HerdrClient(socketPath);
    [this.backoffMin, this.backoffMax] = opts?.backoffMs ?? [1000, 30000];
    this.backoffMs = this.backoffMin;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.backoffMs = this.backoffMin;
    void this.connectCycle(++this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.teardownStreams();
  }

  call<T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> {
    return this.client.call<T>(method, params);
  }

  private teardownStreams(): void {
    this.lifecycleStream?.close();
    this.lifecycleStream = null;
    this.paneStream?.close();
    this.paneStream = null;
    this.paneStreamKey = "";
    this.paneStreamReopening = false;
  }

  private async connectCycle(gen: number): Promise<void> {
    if (gen !== this.generation) return;
    this.events.status("connecting", null);

    let protocolMismatch = false;
    let protocol: number | null = null;
    try {
      const pong = await this.client.call<PongResult>("ping");
      if (gen !== this.generation) return;
      protocol = pong.protocol;
      if (pong.protocol !== EXPECTED_PROTOCOL) {
        // Degraded but still usable — warn and keep connecting.
        protocolMismatch = true;
        this.events.status("protocol-mismatch", protocol);
      }

      const buffered: HerdrEventEnvelope[] = [];
      let seeded = false;
      this.lifecycleStream = await this.client.openStream(LIFECYCLE_SUBS, {
        onEvent: (e) => {
          if (gen !== this.generation) return;
          if (!seeded) {
            buffered.push(e);
            return;
          }
          this.handleLiveEvent(e);
        },
        onClose: () => this.handleStreamDrop(gen),
      });
      if (gen !== this.generation) {
        this.lifecycleStream?.close();
        return;
      }

      const res = await this.client.call<Record<string, unknown>>("session.snapshot");
      if (gen !== this.generation) return;
      // The result nests the snapshot under a "snapshot" key on 0.8.0;
      // tolerate a flat result too.
      const snap = (res.snapshot ?? res) as SessionSnapshot;
      this.cache.seedFromSnapshot(snap);

      for (const e of buffered) {
        this.cache.applyEvent(e, { replay: true });
      }
      seeded = true;
      buffered.length = 0;

      await this.openPaneStream(gen);
      if (gen !== this.generation) return;

      this.backoffMs = this.backoffMin;
      if (!protocolMismatch) this.events.status("online", protocol);
      this.events.agentsChanged(this.cache.agents());
    } catch {
      if (gen !== this.generation) return;
      // A failed connect attempt is "offline" regardless of what ping
      // said earlier in the cycle; mismatch only sticks while connected.
      this.teardownStreams();
      this.events.status("offline", null);
      this.scheduleRetry(gen);
    }
  }

  private scheduleRetry(fromGen: number): void {
    if (!this.running || fromGen !== this.generation) return;
    const jitter = 0.5 + Math.random(); // 0.5x–1.5x
    const delay = Math.min(this.backoffMs * jitter, this.backoffMax);
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffMax);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectCycle(++this.generation);
    }, delay);
  }

  private handleStreamDrop(gen: number): void {
    if (gen !== this.generation || !this.running) return;
    // Any stream close invalidates the whole cycle (we may have missed
    // events) — full reconnect.
    this.generation++;
    this.teardownStreams();
    this.events.status("connecting", null);
    this.scheduleRetry(this.generation);
  }

  private handleLiveEvent(e: HerdrEventEnvelope): void {
    const changed = this.cache.applyEvent(e);
    if (changed) this.scheduleAgentsChanged();
    const key = this.cache.paneIds().join(",");
    if (key !== this.paneStreamKey) {
      void this.reopenPaneStream(this.generation);
    }
  }

  private scheduleAgentsChanged(): void {
    if (this.agentsEmitPending) return;
    this.agentsEmitPending = true;
    const gen = this.generation;
    queueMicrotask(() => {
      this.agentsEmitPending = false;
      if (gen !== this.generation) return;
      this.events.agentsChanged(this.cache.agents());
    });
  }

  /** Open the per-pane status stream for the current pane set. */
  private async openPaneStream(gen: number): Promise<void> {
    // herdr fails an entire subscribe batch when ONE pane_id is stale,
    // and short-lived panes (popups, plugin panes) routinely vanish
    // between their pane_created event and our resubscribe. Tearing the
    // connection down for that would rebuild the identical doomed batch
    // on reconnect — an endless online/connecting flap, observed live on
    // a busy session. Prune the vanished pane and retry instead.
    for (let attempt = 0; attempt <= MAX_STALE_PANE_PRUNES; attempt++) {
      const paneIds = this.cache.paneIds();
      this.paneStreamKey = paneIds.join(",");
      if (paneIds.length === 0) {
        this.paneStream = null;
        return;
      }
      const subs: Subscription[] = paneIds.map((id) => ({
        type: "pane.agent_status_changed",
        pane_id: id,
      }));
      try {
        const stream = await this.client.openStream(subs, {
          onEvent: (e) => {
            if (gen !== this.generation) return;
            if (this.cache.applyEvent(e)) this.scheduleAgentsChanged();
          },
          onClose: () => this.handleStreamDrop(gen),
        });
        if (gen !== this.generation) {
          stream.close();
          return;
        }
        this.paneStream = stream;
        return;
      } catch (err) {
        const stale = stalePaneId(err);
        if (stale === null || gen !== this.generation) throw err;
        if (this.cache.removePane(stale)) this.scheduleAgentsChanged();
      }
    }
    throw new Error(
      `pane subscription still failing after pruning ${MAX_STALE_PANE_PRUNES} stale panes`,
    );
  }

  /**
   * Make-before-break: open the stream for the NEW pane set first, and
   * only close the old one once the new ACK arrived. During the overlap
   * both streams deliver status events; StateCache.applyEvent is
   * idempotent so duplicates are harmless.
   */
  private async reopenPaneStream(gen: number): Promise<void> {
    if (this.paneStreamReopening) return; // key re-checked after open
    this.paneStreamReopening = true;
    try {
      while (gen === this.generation) {
        const old = this.paneStream;
        this.paneStream = null;
        await this.openPaneStream(gen);
        old?.close();
        if (gen !== this.generation) return;
        // The pane set may have changed again while opening.
        if (this.cache.paneIds().join(",") === this.paneStreamKey) return;
      }
    } catch (err) {
      if (gen !== this.generation) return;
      // Subscribe failure (e.g. a pane closed mid-open fails the whole
      // batch) — safest recovery is a full reconnect cycle.
      void err;
      this.handleStreamDrop(gen);
    } finally {
      this.paneStreamReopening = false;
    }
  }
}
