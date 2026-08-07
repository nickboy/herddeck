import { describe, expect, test } from "bun:test";
import { DEFAULT_PLAN_AUTOCYCLE_MS, PlanAutoCycle } from "./planAutoCycle";

/**
 * Capture the registered interval callback and metadata so tests can
 * tick it manually rather than waiting for real timers.
 */
function makeFakeTimers() {
  let cb: (() => void) | null = null;
  let lastMs: number | undefined;
  let cleared = false;
  const handle = { dummy: true } as unknown as ReturnType<typeof setInterval>;
  return {
    setIntervalImpl: (fn: () => void, ms: number) => {
      cb = fn;
      lastMs = ms;
      return handle;
    },
    clearIntervalImpl: () => {
      cleared = true;
    },
    intervalMs: () => lastMs,
    cleared: () => cleared,
    tick: () => {
      if (!cb) throw new Error("interval not registered");
      cb();
    },
  };
}

describe("PlanAutoCycle", () => {
  test("default interval is 4 seconds", () => {
    expect(DEFAULT_PLAN_AUTOCYCLE_MS).toBe(4_000);
  });

  test("start() arms the interval with the configured ms", () => {
    const timers = makeFakeTimers();
    const cycle = new PlanAutoCycle({
      advance: () => {},
      metricCount: () => 2,
      intervalMs: 3_000,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    cycle.start();
    expect(timers.intervalMs()).toBe(3_000);
    expect(cycle.isRunning()).toBe(true);
  });

  test("tick calls advance when at least 2 metrics are available", () => {
    const timers = makeFakeTimers();
    let advances = 0;
    const cycle = new PlanAutoCycle({
      advance: () => {
        advances += 1;
      },
      metricCount: () => 2,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    cycle.start();
    timers.tick();
    timers.tick();
    timers.tick();
    expect(advances).toBe(3);
  });

  test("tick is a no-op when fewer than 2 metrics (nothing to flip between)", () => {
    const timers = makeFakeTimers();
    let advances = 0;
    let metrics = 0;
    const cycle = new PlanAutoCycle({
      advance: () => {
        advances += 1;
      },
      metricCount: () => metrics,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    cycle.start();
    timers.tick(); // metrics=0 → skip
    metrics = 1;
    timers.tick(); // metrics=1 → still skip
    metrics = 2;
    timers.tick(); // metrics=2 → advance
    expect(advances).toBe(1);
  });

  test("metric count is re-checked every tick (handles late population + later emptying)", () => {
    const timers = makeFakeTimers();
    let advances = 0;
    let metrics = 0;
    const cycle = new PlanAutoCycle({
      advance: () => {
        advances += 1;
      },
      metricCount: () => metrics,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    cycle.start();
    timers.tick(); // 0 → skip
    metrics = 3;
    timers.tick(); // 3 → advance
    timers.tick(); // 3 → advance
    metrics = 0;
    timers.tick(); // back to 0 → skip
    expect(advances).toBe(2);
  });

  test("start() is idempotent — second call without stop doesn't double-arm", () => {
    const timers = makeFakeTimers();
    let armCalls = 0;
    const cycle = new PlanAutoCycle({
      advance: () => {},
      metricCount: () => 2,
      setIntervalImpl: (fn, ms) => {
        armCalls += 1;
        return timers.setIntervalImpl(fn, ms);
      },
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    cycle.start();
    cycle.start();
    cycle.start();
    expect(armCalls).toBe(1);
  });

  test("stop() clears the interval; isRunning becomes false", () => {
    const timers = makeFakeTimers();
    const cycle = new PlanAutoCycle({
      advance: () => {},
      metricCount: () => 2,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    cycle.start();
    expect(cycle.isRunning()).toBe(true);
    cycle.stop();
    expect(cycle.isRunning()).toBe(false);
    expect(timers.cleared()).toBe(true);
  });

  test("stop() before start() is a no-op (idempotent shutdown)", () => {
    const timers = makeFakeTimers();
    const cycle = new PlanAutoCycle({
      advance: () => {},
      metricCount: () => 2,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    expect(() => cycle.stop()).not.toThrow();
    expect(cycle.isRunning()).toBe(false);
  });

  test("restart() clears and re-arms — used after a manual press so the next flip is a full interval away", () => {
    let armCalls = 0;
    let clearCalls = 0;
    const cycle = new PlanAutoCycle({
      advance: () => {},
      metricCount: () => 2,
      setIntervalImpl: (_fn, _ms) => {
        armCalls += 1;
        return { dummy: true } as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalImpl: () => {
        clearCalls += 1;
      },
    });
    cycle.start();
    cycle.restart();
    expect(armCalls).toBe(2);
    expect(clearCalls).toBe(1);
  });
});
