import { EventEmitter } from "node:events";
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
  private handle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private consecutiveErrors = 0;
  private currentIntervalMs = 0;

  /**
   * Cap on the exponential backoff so we never go more than 10 min
   * between attempts. Aligns with "if you're rate-limited for >10 min
   * something else is wrong; let the user notice in daemon.log."
   */
  private static readonly MAX_BACKOFF_MS = 10 * 60_000;

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
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.currentIntervalMs = this.intervalMs;
    console.log(`plan poller start intervalMs=${this.intervalMs}`);
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
      this.currentIntervalMs = this.intervalMs;
    } else {
      this.consecutiveErrors += 1;
      // 1× → 2× → 4× → 8× ... capped. Math.min on the cap so we never
      // exceed MAX_BACKOFF_MS even if consecutiveErrors gets large.
      const factor = 2 ** Math.min(this.consecutiveErrors, 20);
      this.currentIntervalMs = Math.min(this.intervalMs * factor, PlanUsagePoller.MAX_BACKOFF_MS);
    }
    if (this.currentIntervalMs !== previousMs) {
      console.log(
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
    const lastStatusline = this.getLastStatuslineAt();
    if (lastStatusline > 0) {
      const age = this.clock() - lastStatusline;
      if (age < PlanUsagePoller.STATUSLINE_FRESH_MS) {
        console.log(`plan poll skipped — statusline fresh (${age}ms ago)`);
        return;
      }
    }
    console.log("plan poll tick");
    try {
      // Pass empty cookie. The production fetcher reads from Keychain;
      // legacy fetchers that consumed this value have been removed.
      const result = await this.fetcher("");
      if ("error" in result) {
        console.log(`plan:error reason=${result.error}`);
        this.emit("error", result.error);
        this.updateCadence(false);
        return;
      }
      const summary = result.metrics.map((m) => `${m.key}=${Math.round(m.percentUsed)}%`).join(" ");
      console.log(`plan:update metrics=${result.metrics.length} ${summary}`);
      this.emit("update", result);
      this.updateCadence(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`plan:error reason=${msg}`);
      this.emit("error", msg);
      this.updateCadence(false);
    }
  }
}
