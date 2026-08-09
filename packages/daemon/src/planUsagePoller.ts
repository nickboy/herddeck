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
export type PlanFetcher = (cookie: string) => Promise<PlanUsageSnapshot | { error: string }>;

type SetIntervalImpl = (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
type ClearIntervalImpl = (handle: ReturnType<typeof setInterval>) => void;

export interface PlanUsagePollerOptions {
  fetcher: PlanFetcher;
  intervalMs: number;
  clock?: () => number;
  setIntervalImpl?: SetIntervalImpl;
  clearIntervalImpl?: ClearIntervalImpl;
  /**
   * Returns the last instant (`clock()` units) that Claude Code's
   * statusline channel delivered a parsable `rate_limits` snapshot.
   * Returns 0 when the daemon has never seen one. When the gate sees a
   * value newer than `STATUSLINE_FRESH_MS` ago, `tick()` short-circuits
   * before hitting Anthropic — the push channel is the source of truth
   * for active Claude sessions. Defaults to `() => 0` (gate disabled,
   * fall back to legacy unconditional polling).
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
 * Error policy: emit `error` and keep polling, with exponential
 * backoff on consecutive failures so HTTP 429 (Anthropic
 * rate-limiting) doesn't keep hammering at the configured interval.
 * Backoff escalates 2× per consecutive error capped at MAX_BACKOFF_MS
 * (10 min); a successful tick resets to the base interval.
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
  /**
   * Adaptive floor for the polling cadence, at or above the configured
   * interval.
   *
   * Consecutive-error backoff cannot fix steady-state throttling, and
   * this endpoint produced exactly that: 1136 successes against 543
   * HTTP 429s, arriving interleaved rather than in runs. One success
   * reset the counter, so the cadence oscillated between the base
   * interval and one doubling — forever, permanently at the ceiling,
   * with `errors=1` logged 492 times and `errors=4` only 5.
   *
   * Backoff answers "the service is down". This answers "we are asking
   * too often", which is a different question: every 429 raises the
   * floor, and only a sustained clean streak lowers it again.
   */
  private floorMs: number;
  private cleanStreak = 0;

  /**
   * Cap on the exponential backoff so we never go more than 10 min
   * between attempts. Aligns with "if you're rate-limited for >10 min
   * something else is wrong; let the user notice in daemon.log."
   */
  private static readonly MAX_BACKOFF_MS = 10 * 60_000;

  /** Multiplicative step for the adaptive floor, and how many clean
   * ticks it takes to earn a step back down. Deliberately asymmetric:
   * back off fast, recover slowly. */
  private static readonly FLOOR_STEP = 1.5;
  private static readonly CLEAN_STREAK_TO_RECOVER = 5;

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
    this.floorMs = opts.intervalMs;
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
  private updateCadence(success: boolean): void {
    const previousMs = this.currentIntervalMs;
    if (success) {
      this.consecutiveErrors = 0;
      this.cleanStreak += 1;
      // Earn the floor back only after a run of clean ticks, so an
      // interleaved 2-in-3 success rate cannot undo a raise.
      if (this.cleanStreak >= PlanUsagePoller.CLEAN_STREAK_TO_RECOVER) {
        this.cleanStreak = 0;
        this.floorMs = Math.max(this.intervalMs, this.floorMs / PlanUsagePoller.FLOOR_STEP);
      }
      this.currentIntervalMs = this.floorMs;
    } else {
      this.consecutiveErrors += 1;
      this.cleanStreak = 0;
      // Any failure means we are asking too often — raise the floor,
      // not just this one gap.
      this.floorMs = Math.min(
        this.floorMs * PlanUsagePoller.FLOOR_STEP,
        PlanUsagePoller.MAX_BACKOFF_MS,
      );
      // 1× → 2× → 4× → 8× ... capped. Math.min on the cap so we never
      // exceed MAX_BACKOFF_MS even if consecutiveErrors gets large.
      const factor = 2 ** Math.min(this.consecutiveErrors, 20);
      this.currentIntervalMs = Math.min(this.floorMs * factor, PlanUsagePoller.MAX_BACKOFF_MS);
    }
    if (this.currentIntervalMs !== previousMs) {
      logInfo(
        `plan poller backoff: errors=${this.consecutiveErrors} nextTickMs=${this.currentIntervalMs}`,
      );
      this.scheduleNext();
    }
  }

  private async tick(): Promise<void> {
    // Freshness gate: skip the Anthropic API hit entirely when the
    // statusline push channel delivered a snapshot recently. Keeps
    // the poller available as a fallback (no Claude session active,
    // or daemon just booted) but avoids the rate-limited endpoint
    // during normal interactive use.
    if (!this.hasViewer()) {
      logInfo("plan poll skipped — no plugin connected");
      return;
    }
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
