import { EventEmitter } from "node:events";
import { logInfo } from "./log";
import type { PlanUsageSnapshot } from "./planTypes";

/**
 * Plan-usage fetcher signature. The `cookie` argument is vestigial —
 * the production fetcher (`claudeAiFetcher.ts`) authenticates via
 * macOS Keychain (`Claude Code-credentials`) and ignores this value.
 * Kept on the type so older fetchers (or tests) that read it don't
 * break, but new callers should pass an empty string.
 */
export type PlanFetcher = (
  cookie: string,
) => Promise<PlanUsageSnapshot | { error: string; retryAfterMs?: number }>;

type SetIntervalImpl = (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
type ClearIntervalImpl = (handle: ReturnType<typeof setInterval>) => void;

export interface PlanUsagePollerOptions {
  fetcher: PlanFetcher;
  intervalMs: number;
  clock?: () => number;
  setIntervalImpl?: SetIntervalImpl;
  clearIntervalImpl?: ClearIntervalImpl;
  /**
   * Returns the last instant (`clock()` units) that a statusline channel
   * delivered a parsable `rate_limits` snapshot; 0 when never.
   *
   * NOTHING POPULATES THIS TODAY. The channel does not exist: the
   * bundled statusline reports per-pane context to herdr, not
   * account-scoped plan usage, and it is not established that Claude
   * Code's statusline payload carries plan windows at all. The seam is
   * kept because it is the right shape if that channel is ever built —
   * but read this as an intention, not a defence the poller currently
   * has. `index.ts` does not pass it, so the gate has never once fired.
   */
  getLastStatuslineAt?: () => number;
  /**
   * Whether anyone can actually see the Plan Usage key right now.
   * Returns false when no Stream Deck plugin is connected, and the tick
   * is skipped entirely.
   *
   * This is the cheapest possible rate-limit fix: a daemon on a machine
   * with no deck attached — the herdr host in a two-machine setup — was
   * spending the account's whole request budget rendering a key nobody
   * could look at. Defaults to `() => true` (always poll).
   */
  hasViewer?: () => boolean;
}

/**
 * Periodically fetches Claude Max plan usage and emits `update` / `error`.
 *
 * Injection seams:
 *   - `fetcher` — so tests can return a canned snapshot without hitting the network.
 *   - `setIntervalImpl` / `clearIntervalImpl` — so tests don't need real time.
 *   - `clock` — for deterministic `fetchedAt` stamping by fetchers that want it.
 *
 * Error policy: emit `error` and keep polling. Two distinct mechanisms,
 * because "the service is down" and "we are asking too often" are
 * different problems:
 *
 *   - consecutive-error backoff, for outages: 2x per consecutive error,
 *     cleared by any success.
 *   - an adaptive floor, for sustained throttling: raised by every
 *     failure, lowered only by a run of clean ticks. A single success
 *     does NOT restore the base interval, because the 429s this exists
 *     for arrive interleaved rather than in runs.
 */
export class PlanUsagePoller extends EventEmitter {
  private readonly fetcher: PlanFetcher;
  private readonly intervalMs: number;
  private readonly setIntervalImpl: SetIntervalImpl;
  private readonly clearIntervalImpl: ClearIntervalImpl;
  private readonly clock: () => number;
  private readonly getLastStatuslineAt: () => number;
  private readonly hasViewer: () => boolean;
  private handle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private consecutiveErrors = 0;
  private currentIntervalMs = 0;
  private readonly maxBackoffMs: number;
  /** Set from a 429/503 `Retry-After`; consumed by the next cadence
   * update and cleared, so a stale hint can never outlive its response. */
  private retryAfterMs: number | undefined;

  /**
   * Cap on the exponential backoff so we never go more than 10 min
   * between attempts. Aligns with "if you're rate-limited for >10 min
   * something else is wrong; let the user notice in daemon.log."
   */
  private static readonly MAX_BACKOFF_FLOOR_MS = 10 * 60_000;

  /**
   * Skip the fetch when the statusline channel delivered a snapshot
   * inside this window. Matches the design doc's 10-minute gate:
   * statusline ticks ride the user's actual Claude activity, so any
   * gap longer than 10 min strongly implies the user has stepped away
   * and the poller should resume covering the display.
   */
  private static readonly STATUSLINE_FRESH_MS = 10 * 60_000;

  constructor(opts: PlanUsagePollerOptions) {
    super();
    this.fetcher = opts.fetcher;
    this.intervalMs = opts.intervalMs;
    this.setIntervalImpl = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalImpl = opts.clearIntervalImpl ?? ((h) => clearInterval(h));
    this.clock = opts.clock ?? Date.now;
    this.getLastStatuslineAt = opts.getLastStatuslineAt ?? (() => 0);
    this.hasViewer = opts.hasViewer ?? (() => true);
    // The cap has to scale off the base or the ladder degenerates. At a
    // 300s base a fixed 10-minute ceiling allows exactly one doubling;
    // 8x reproduces the shape the design had at 60s (60→120→240→480).
    this.maxBackoffMs = Math.max(PlanUsagePoller.MAX_BACKOFF_FLOOR_MS, opts.intervalMs * 8);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.currentIntervalMs = this.intervalMs;
    logInfo(`plan poller start intervalMs=${this.intervalMs}`);
    // Fire once immediately so the plugin doesn't wait a full interval
    // for the first snapshot. Don't await — start() stays sync.
    // Errors flow through `tick` and bump the backoff counter; the
    // interval handle is re-armed each time the cadence changes so
    // 429s don't keep hammering at 60s.
    void this.tick();
    this.scheduleNext();
  }

  stop(): void {
    this.clearTimer();
    this.running = false;
  }

  private clearTimer(): void {
    if (this.handle !== null) {
      this.clearIntervalImpl(this.handle);
      this.handle = null;
    }
  }

  private scheduleNext(): void {
    this.clearTimer();
    if (!this.running) return;
    this.handle = this.setIntervalImpl(() => {
      void this.tick();
    }, this.currentIntervalMs);
  }

  /**
   * Recompute the cadence after success/failure and re-arm the
   * interval if it changed. Centralised so the success and error
   * paths can't drift in the next-interval math.
   */
  /**
   * Recompute the cadence after success/failure and re-arm the interval
   * if it changed.
   *
   * Three cases, and the ordering matters:
   *
   *   success                    -> base interval
   *   throttled, server timed it -> obey Retry-After, clamped
   *   anything else              -> 2x consecutive-error backoff
   *
   * An earlier version carried an adaptive floor that every failure
   * raised and only a run of clean ticks lowered. It was deleted rather
   * than tuned. It was measured against a 60s interval and shipped
   * alongside a change to 300s, where `maxBackoff / base` is 2 and one
   * floor step is 1.5 — so the first failure already exceeded the cap
   * and the consecutive-error term never affected an outcome. It also
   * raised the floor on failures that have nothing to do with request
   * rate: an expired OAuth token pinned the cadence at the ceiling, and
   * kept it there for tens of minutes after the user re-authenticated.
   *
   * Anthropic states the correct wait in `Retry-After`. Obeying the
   * server beats any heuristic that guesses at it.
   */
  private updateCadence(success: boolean): void {
    const previousMs = this.currentIntervalMs;
    const retryAfterMs = this.retryAfterMs;
    this.retryAfterMs = undefined;

    if (success) {
      this.consecutiveErrors = 0;
      this.currentIntervalMs = this.intervalMs;
    } else if (retryAfterMs !== undefined) {
      // Never poll sooner than the base interval even if the server says
      // we may — nothing on this key needs sub-interval freshness.
      this.consecutiveErrors = 0;
      this.currentIntervalMs = Math.min(Math.max(retryAfterMs, this.intervalMs), this.maxBackoffMs);
    } else {
      this.consecutiveErrors += 1;
      const factor = 2 ** Math.min(this.consecutiveErrors, 20);
      this.currentIntervalMs = Math.min(this.intervalMs * factor, this.maxBackoffMs);
    }

    if (this.currentIntervalMs !== previousMs) {
      const hint = retryAfterMs !== undefined ? ` (retry-after ${retryAfterMs}ms)` : "";
      logInfo(
        `plan poller cadence: errors=${this.consecutiveErrors} nextTickMs=${this.currentIntervalMs}${hint}`,
      );
      this.scheduleNext();
    }
  }

  private async tick(): Promise<void> {
    // Viewer gate: nobody has the Plan Usage key on screen, so there is
    // nothing to render and no reason to spend a request. Deliberately
    // returns without touching updateCadence — a skipped tick is
    // evidence of neither success nor throttling, and counting it as
    // clean would let a headless daemon walk its floor back down
    // without issuing a single request.
    if (!this.hasViewer()) {
      logInfo("plan poll skipped — no plugin connected");
      return;
    }
    // Freshness gate — inert in production; see getLastStatuslineAt.
    const lastStatusline = this.getLastStatuslineAt();
    if (lastStatusline > 0) {
      const age = this.clock() - lastStatusline;
      if (age < PlanUsagePoller.STATUSLINE_FRESH_MS) {
        logInfo(`plan poll skipped — statusline fresh (${age}ms ago)`);
        return;
      }
    }
    logInfo("plan poll tick");
    try {
      // Pass empty cookie. The production fetcher reads from Keychain;
      // legacy fetchers that consumed this value have been removed.
      const result = await this.fetcher("");
      if ("error" in result) {
        this.retryAfterMs = result.retryAfterMs;
        logInfo(`plan:error reason=${result.error}`);
        this.emit("error", result.error);
        this.updateCadence(false);
        return;
      }
      const summary = result.metrics.map((m) => `${m.key}=${Math.round(m.percentUsed)}%`).join(" ");
      logInfo(`plan:update metrics=${result.metrics.length} ${summary}`);
      this.emit("update", result);
      this.updateCadence(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logInfo(`plan:error reason=${msg}`);
      this.emit("error", msg);
      this.updateCadence(false);
    }
  }
}
