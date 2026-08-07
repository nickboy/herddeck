import type { PlanMetricKey } from "../wire";

/**
 * Auto-cycles `planMode` across the available metrics every
 * `intervalMs` so the Stream Deck Plan Usage key shows both 5h and 7d
 * (and any future buckets) without requiring the user to press it.
 * Manual press still cycles immediately AND resets the timer so the
 * user gets the full window with their chosen metric.
 *
 * Pure timer-orchestration class with no Stream Deck SDK imports —
 * lets unit tests drive it with a fake clock + interval impl. Ported
 * unchanged from claudedeck.
 *
 * Lifecycle:
 *   - `start()` arms the interval. No-op if already running.
 *   - `restart()` resets the timer (use after a manual press so the
 *     auto-flip doesn't fire 50ms after the user pressed).
 *   - `stop()` clears the interval. Safe to call multiple times.
 *
 * The class doesn't own `planMode`; it calls back into the consumer's
 * `advance` function which is responsible for picking the next mode
 * (using `cyclePlanMode`) and triggering a repaint.
 */
export interface PlanAutoCycleOptions {
  /** Milliseconds between auto-flips. Default 4000. */
  intervalMs?: number;
  /**
   * Callback invoked when the timer fires. Should pick the next metric
   * and trigger a repaint. The consumer owns `planMode` mutation and
   * the repaint side-effect.
   */
  advance: () => void;
  /**
   * Returns the count of currently-available metrics. When < 2, the
   * timer self-suppresses (nothing to flip between). Re-checked every
   * tick so a daemon hiccup that empties the list won't keep flipping
   * to nowhere.
   */
  metricCount: () => number;
  /** Injection seam — defaults to `setInterval`. */
  setIntervalImpl?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** Injection seam — defaults to `clearInterval`. */
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
}

export const DEFAULT_PLAN_AUTOCYCLE_MS = 4_000;

export class PlanAutoCycle {
  private readonly intervalMs: number;
  private readonly advance: () => void;
  private readonly metricCount: () => number;
  private readonly setIntervalImpl: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalImpl: (handle: ReturnType<typeof setInterval>) => void;
  private handle: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PlanAutoCycleOptions) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_PLAN_AUTOCYCLE_MS;
    this.advance = opts.advance;
    this.metricCount = opts.metricCount;
    this.setIntervalImpl = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalImpl = opts.clearIntervalImpl ?? ((h) => clearInterval(h));
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.setIntervalImpl(() => {
      if (this.metricCount() < 2) return;
      this.advance();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.clearIntervalImpl(this.handle);
    this.handle = null;
  }

  /** Stop and immediately start again so the next flip is a full
   * interval away. Used after a manual key press. */
  restart(): void {
    this.stop();
    this.start();
  }

  isRunning(): boolean {
    return this.handle !== null;
  }
}

/**
 * Helper: given the available metric keys and the current mode, returns
 * the next mode (wraps around). Pure — kept out of PlanAutoCycle so the
 * auto-cycle timer can share the same advancement function as the
 * manual press path (cyclePlanMode in actions/planUsage.ts).
 *
 * Note: kept here too for symmetry, but `cyclePlanMode` from
 * `./planUsage` is the canonical implementation. This module's
 * `advance` callback is whatever the consumer wires up.
 */
export type PlanMetricKeyList = readonly PlanMetricKey[];
