import { describe, expect, test } from "bun:test";
import type { PlanUsageSnapshot } from "./planTypes";
import { PlanUsagePoller } from "./planUsagePoller";

/**
 * Minimal fake timer so we can drive tick() manually instead of waiting for
 * real `setInterval`. We collect the callback registered by the poller and
 * expose a `tick()` helper that invokes it.
 */
function makeFakeTimers(): {
  setIntervalImpl: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearIntervalImpl: (h: ReturnType<typeof setTimeout>) => void;
  callCount: () => number;
  intervalMs: () => number | undefined;
  tick: () => Promise<void>;
  cleared: () => boolean;
} {
  let cb: (() => void) | null = null;
  let lastMs: number | undefined;
  let clearedFlag = false;
  let calls = 0;
  // A sentinel handle (we don't need a real one, just something truthy).
  const handle = { dummy: true } as unknown as ReturnType<typeof setTimeout>;
  return {
    setIntervalImpl: (fn, ms) => {
      cb = fn;
      lastMs = ms;
      calls += 1;
      return handle;
    },
    clearIntervalImpl: (h) => {
      void h;
      clearedFlag = true;
    },
    callCount: () => calls,
    intervalMs: () => lastMs,
    tick: async () => {
      if (!cb) throw new Error("interval never registered");
      await cb();
    },
    cleared: () => clearedFlag,
  };
}

const sampleSnapshot: PlanUsageSnapshot = {
  metrics: [
    { key: "fiveHour", label: "5h session", percentUsed: 10, resetAt: null },
    { key: "sevenDay", label: "Weekly all", percentUsed: 20, resetAt: null },
    { key: "extraUsage", label: "Weekly Sonnet", percentUsed: 30, resetAt: null },
  ],
  fetchedAt: 111,
};

describe("PlanUsagePoller", () => {
  test("start() polls immediately and schedules an interval (no cookie gate)", async () => {
    // Regression: an earlier version refused to start polling when
    // ~/.claudedeck/cookie was absent. The cookie file is vestigial —
    // the production fetcher reads from macOS Keychain — so the poller
    // must always start as long as the fetcher is provided.
    const timers = makeFakeTimers();
    let fetcherCalls = 0;
    const poller = new PlanUsagePoller({
      fetcher: async () => {
        fetcherCalls += 1;
        return sampleSnapshot;
      },
      intervalMs: 42_000,
      clock: () => 111,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });

    const updates: PlanUsageSnapshot[] = [];
    poller.on("update", (snapshot: PlanUsageSnapshot) => updates.push(snapshot));

    poller.start();
    // Let the immediate-poll microtask settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(timers.callCount()).toBe(1);
    expect(timers.intervalMs()).toBe(42_000);
    expect(fetcherCalls).toBe(1);
    expect(updates.length).toBe(1);
    expect(updates[0]?.metrics.length).toBe(3);

    // Driving the interval produces another fetch.
    await timers.tick();
    expect(fetcherCalls).toBe(2);
    expect(updates.length).toBe(2);
  });

  test("fetcher receives an empty cookie string (production fetcher ignores it)", async () => {
    // The legacy fetcher signature `(cookie: string) => …` is preserved
    // for backward compatibility, but new code shouldn't depend on the
    // value. Make sure we hand in the empty string explicitly.
    const timers = makeFakeTimers();
    const seenCookies: string[] = [];
    const poller = new PlanUsagePoller({
      fetcher: async (cookie: string) => {
        seenCookies.push(cookie);
        return sampleSnapshot;
      },
      intervalMs: 1000,
      clock: () => 111,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    await timers.tick();
    expect(seenCookies).toEqual(["", ""]);
  });

  test("fetcher returning `{error}` emits `error` and keeps polling", async () => {
    const timers = makeFakeTimers();
    let call = 0;
    const poller = new PlanUsagePoller({
      fetcher: async () => {
        call += 1;
        return call === 1 ? { error: "first failed" } : sampleSnapshot;
      },
      intervalMs: 1000,
      clock: () => 111,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });

    const errors: string[] = [];
    const updates: PlanUsageSnapshot[] = [];
    poller.on("error", (r: string) => errors.push(r));
    poller.on("update", (s: PlanUsageSnapshot) => updates.push(s));

    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual(["first failed"]);
    expect(updates.length).toBe(0);

    await timers.tick();
    expect(updates.length).toBe(1);
    expect(errors.length).toBe(1);
  });

  test("fetcher throwing becomes an `error` emission (not an uncaught rejection)", async () => {
    const timers = makeFakeTimers();
    const poller = new PlanUsagePoller({
      fetcher: async () => {
        throw new Error("network down");
      },
      intervalMs: 1000,
      clock: () => 111,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });

    const errors: string[] = [];
    poller.on("error", (r: string) => errors.push(r));

    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/network down/);
  });

  test("stop() clears the interval", async () => {
    const timers = makeFakeTimers();
    const poller = new PlanUsagePoller({
      fetcher: async () => sampleSnapshot,
      intervalMs: 1000,
      clock: () => 111,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(timers.cleared()).toBe(false);
    poller.stop();
    expect(timers.cleared()).toBe(true);
  });

  test("stop() before start() is a no-op", () => {
    const timers = makeFakeTimers();
    const poller = new PlanUsagePoller({
      fetcher: async () => sampleSnapshot,
      intervalMs: 1000,
      clock: () => 111,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    expect(() => poller.stop()).not.toThrow();
  });

  test("start() ignores a second call while already running", async () => {
    const timers = makeFakeTimers();
    const poller = new PlanUsagePoller({
      fetcher: async () => sampleSnapshot,
      intervalMs: 1000,
      clock: () => 111,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    poller.start();
    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(timers.callCount()).toBe(1);
  });
});

describe("PlanUsagePoller exponential backoff", () => {
  /**
   * Track every interval registered + cleared so we can assert that
   * the poller re-arms with a longer interval after each consecutive
   * error and snaps back to the base interval on the first success.
   */
  function makeBackoffTimers(): {
    setIntervalImpl: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearIntervalImpl: (h: ReturnType<typeof setTimeout>) => void;
    intervals: number[];
    tickAll: () => Promise<void>;
  } {
    const intervals: number[] = [];
    let currentCb: (() => void) | null = null;
    const handle = { dummy: true } as unknown as ReturnType<typeof setTimeout>;
    return {
      setIntervalImpl: (fn, ms) => {
        currentCb = fn;
        intervals.push(ms);
        return handle;
      },
      clearIntervalImpl: () => {
        currentCb = null;
      },
      intervals,
      tickAll: async () => {
        if (!currentCb) throw new Error("no interval armed");
        await currentCb();
        // microtask flush so the async tick body completes before the
        // next call sees stale state.
        await new Promise((r) => setTimeout(r, 0));
      },
    };
  }

  test("consecutive errors escalate the interval 2× each tick (capped at 10 min)", async () => {
    const timers = makeBackoffTimers();
    const poller = new PlanUsagePoller({
      fetcher: async () => ({ error: "HTTP 429" }),
      intervalMs: 60_000, // 1 min base, mirrors production
      clock: () => 0,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    // EventEmitter throws an unhandled-error if `error` is emitted
    // without a listener. Subscribe a noop so the test doesn't
    // explode on the first emit.
    poller.on("error", () => {});
    poller.start();
    // Initial start() armed at base interval before the immediate
    // tick fired — the first tick is in flight and will update cadence.
    await new Promise((r) => setTimeout(r, 0));
    // After immediate tick (error #1): 2× base = 120000
    expect(timers.intervals.at(-1)).toBe(120_000);
    // Drive subsequent ticks, each compounding.
    await timers.tickAll();
    expect(timers.intervals.at(-1)).toBe(240_000); // 4×
    await timers.tickAll();
    expect(timers.intervals.at(-1)).toBe(480_000); // 8×
    // Cap at 10 min (600_000) after enough errors. 16× = 960000 > cap.
    await timers.tickAll();
    expect(timers.intervals.at(-1)).toBe(600_000);
    await timers.tickAll();
    expect(timers.intervals.at(-1)).toBe(600_000); // stays capped
  });

  test("a successful tick after errors resets cadence to base interval", async () => {
    const timers = makeBackoffTimers();
    let nthCall = 0;
    const poller = new PlanUsagePoller({
      fetcher: async () => {
        nthCall += 1;
        if (nthCall <= 2) return { error: "HTTP 429" };
        return sampleSnapshot;
      },
      intervalMs: 60_000,
      clock: () => 0,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    poller.on("error", () => {});
    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(timers.intervals.at(-1)).toBe(120_000); // after error 1
    await timers.tickAll();
    expect(timers.intervals.at(-1)).toBe(240_000); // after error 2
    await timers.tickAll();
    // Third tick succeeds → cadence resets to base.
    expect(timers.intervals.at(-1)).toBe(60_000);
  });

  test("zero errors keep the original interval (no spurious re-arm)", async () => {
    const timers = makeBackoffTimers();
    const poller = new PlanUsagePoller({
      fetcher: async () => sampleSnapshot,
      intervalMs: 60_000,
      clock: () => 0,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    // Only one setInterval call — base interval, no backoff re-arm.
    expect(timers.intervals).toEqual([60_000]);
    await timers.tickAll();
    await timers.tickAll();
    expect(timers.intervals).toEqual([60_000]);
  });
});

describe("PlanUsagePoller statusline freshness gate", () => {
  test("skips fetch when statusline snapshot is younger than the 10-min window", async () => {
    const timers = makeFakeTimers();
    let fetchCalls = 0;
    const nowMs = 1_000_000;
    const poller = new PlanUsagePoller({
      fetcher: async () => {
        fetchCalls += 1;
        return sampleSnapshot;
      },
      intervalMs: 60_000,
      clock: () => nowMs,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      // Statusline arrived 5 minutes ago — well within the 10-min freshness window.
      getLastStatuslineAt: () => nowMs - 5 * 60_000,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    // First (immediate) tick must short-circuit.
    expect(fetchCalls).toBe(0);
    // Scheduled tick still short-circuits while the gate is fresh.
    await timers.tick();
    expect(fetchCalls).toBe(0);
  });

  test("falls through to fetch when statusline is older than 10 min", async () => {
    const timers = makeFakeTimers();
    let fetchCalls = 0;
    const nowMs = 1_000_000;
    const poller = new PlanUsagePoller({
      fetcher: async () => {
        fetchCalls += 1;
        return sampleSnapshot;
      },
      intervalMs: 60_000,
      clock: () => nowMs,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      // Stale statusline (11 min old) → poller should resume.
      getLastStatuslineAt: () => nowMs - 11 * 60_000,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toBe(1);
  });

  test("gate is disabled (always fetches) when getter returns 0", async () => {
    const timers = makeFakeTimers();
    let fetchCalls = 0;
    const poller = new PlanUsagePoller({
      fetcher: async () => {
        fetchCalls += 1;
        return sampleSnapshot;
      },
      intervalMs: 60_000,
      clock: () => 1_000_000,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      getLastStatuslineAt: () => 0,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toBe(1);
  });

  test("gate is disabled by default (no option provided) — legacy behaviour", async () => {
    const timers = makeFakeTimers();
    let fetchCalls = 0;
    const poller = new PlanUsagePoller({
      fetcher: async () => {
        fetchCalls += 1;
        return sampleSnapshot;
      },
      intervalMs: 60_000,
      clock: () => 1_000_000,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      // No getLastStatuslineAt — defaults to () => 0
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toBe(1);
  });

  test("transition from fresh → stale flips fetching back on", async () => {
    const timers = makeFakeTimers();
    let fetchCalls = 0;
    let lastStatusline = 1_000_000 - 60_000; // 1 min ago, fresh
    const poller = new PlanUsagePoller({
      fetcher: async () => {
        fetchCalls += 1;
        return sampleSnapshot;
      },
      intervalMs: 60_000,
      clock: () => 1_000_000,
      setIntervalImpl: timers.setIntervalImpl,
      clearIntervalImpl: timers.clearIntervalImpl,
      getLastStatuslineAt: () => lastStatusline,
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchCalls).toBe(0); // skipped (fresh)
    // Simulate Claude session going idle: statusline pushes stop, age grows past 10 min.
    lastStatusline = 1_000_000 - 11 * 60_000;
    await timers.tick();
    expect(fetchCalls).toBe(1); // resumed
  });
});
