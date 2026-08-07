import { describe, expect, test } from "bun:test";
import type { PlanMetric, PlanMetricKey } from "../wire";
import { cyclePlanMode, renderPlanUsage, renderPlanUsageImage } from "./planUsage";

const makeMetric = (
  key: PlanMetricKey,
  percentUsed: number,
  label: string = key,
  detail?: string,
): PlanMetric => ({ key, label, percentUsed, resetAt: null, detail });

describe("renderPlanUsage — empty states", () => {
  test("placeholder render when no metrics and no error", () => {
    const r = renderPlanUsage([], "fiveHour", undefined);
    // SDK title is always empty; visual goes in the SVG via renderPlanUsageImage.
    expect(r.title).toBe("");
    expect(r.displayName).toBe("plan");
    expect(r.detail).toBe("USE");
    // No donut in placeholder state.
    expect(r.percentUsed).toBeUndefined();
    expect(r.fillColor).toBeUndefined();
    expect(r.alert).toBe(false);
  });

  test("error state when lastError is present", () => {
    const r = renderPlanUsage([], "fiveHour", "401 expired");
    expect(r.displayName).toBe("error");
    expect(r.errorText).toContain("401");
    expect(r.alert).toBe(true);
    // No donut while errored — the number isn't current.
    expect(r.percentUsed).toBeUndefined();
  });

  test("truncates a long error to 18 chars (preserves useful prefix)", () => {
    const r = renderPlanUsage([], "fiveHour", "access token expired or invalid");
    expect(r.errorText).toBe("access token expi…");
  });
});

describe("renderPlanUsage — metric thresholds", () => {
  const five = makeMetric("fiveHour", 14, "5h session", "46m left");

  test("healthy <50% → green donut + detail visible", () => {
    const r = renderPlanUsage([five], "fiveHour", undefined);
    // "5h session" is exactly 10 chars, the truncation budget — no
    // ellipsis applied.
    expect(r.displayName).toBe("5h session");
    expect(r.percentUsed).toBe(14);
    expect(r.fillColor).toBe("#94e2d5");
    expect(r.detail).toBe("46m left");
    expect(r.warn).toBe(false);
    expect(r.alert).toBe(false);
  });

  test("warn at 50% ≤ p < 80% → yellow", () => {
    const r = renderPlanUsage([makeMetric("fiveHour", 60)], "fiveHour", undefined);
    expect(r.fillColor).toBe("#f9e2af");
    expect(r.warn).toBe(true);
    expect(r.alert).toBe(false);
  });

  test("alert at p ≥ 80% → red + alert flag", () => {
    const r = renderPlanUsage([makeMetric("fiveHour", 80)], "fiveHour", undefined);
    expect(r.fillColor).toBe("#f38ba8");
    expect(r.alert).toBe(true);
  });

  test("overflow (>100%) clamps to red", () => {
    const r = renderPlanUsage([makeMetric("fiveHour", 150)], "fiveHour", undefined);
    expect(r.fillColor).toBe("#f38ba8");
    expect(r.alert).toBe(true);
  });
});

describe("renderPlanUsage — mode selection", () => {
  const metrics: PlanMetric[] = [
    makeMetric("fiveHour", 10, "5h"),
    makeMetric("sevenDay", 40, "Weekly"),
    makeMetric("extraUsage", 70, "Sonnet"),
  ];

  test("selects the metric matching currentMode", () => {
    expect(renderPlanUsage(metrics, "sevenDay", undefined).displayName).toBe("Weekly");
    expect(renderPlanUsage(metrics, "extraUsage", undefined).displayName).toBe("Sonnet");
  });

  test("falls back to the first metric when currentMode isn't in the list", () => {
    const partial = metrics.filter((m) => m.key !== "extraUsage");
    const r = renderPlanUsage(partial, "extraUsage", undefined);
    expect(r.displayName).toBe("5h");
  });
});

describe("renderPlanUsageImage — donut + name + detail", () => {
  test("donut SVG carries the threshold color + center % text", () => {
    const url = renderPlanUsageImage({
      backgroundHex: "#1e1e2e",
      displayName: "5h",
      percentUsed: 60,
      fillColor: "#f9e2af",
      detail: "46m",
    });
    expect(url).toContain(encodeURIComponent("#f9e2af"));
    expect(url).toContain(encodeURIComponent('cy="44"'));
    expect(url).toContain(encodeURIComponent("60%"));
    expect(url).toContain(encodeURIComponent("46m"));
    expect(url).toContain(encodeURIComponent("5h"));
  });

  test("0% renders track only (no arc), still shows the centre `0%`", () => {
    const url = renderPlanUsageImage({
      backgroundHex: "#1e1e2e",
      displayName: "5h",
      percentUsed: 0,
      fillColor: "#94e2d5",
    });
    expect(url).toContain(encodeURIComponent('stroke-opacity="0.35"'));
    // Green arc fill should be absent for 0%.
    expect(url).not.toContain(encodeURIComponent("#94e2d5"));
    expect(url).toContain(encodeURIComponent("0%"));
  });

  test("100% renders a closed ring (dashoffset = 0)", () => {
    const url = renderPlanUsageImage({
      backgroundHex: "#742a2a",
      displayName: "Weekly",
      percentUsed: 100,
      fillColor: "#f38ba8",
    });
    expect(url).toContain(encodeURIComponent('stroke-dashoffset="0.00"'));
    expect(url).toContain(encodeURIComponent("100%"));
  });

  test("error variant has reason text + no donut", () => {
    const url = renderPlanUsageImage({
      backgroundHex: "#742a2a",
      displayName: "error",
      errorText: "HTTP 429",
    });
    expect(url).toContain(encodeURIComponent("error"));
    expect(url).toContain(encodeURIComponent("HTTP 429"));
    // No cy=44 donut element.
    expect(url).not.toContain(encodeURIComponent('cy="44"'));
  });

  test("placeholder variant just shows the name + detail (no donut)", () => {
    const url = renderPlanUsageImage({
      backgroundHex: "#1c1f26",
      displayName: "plan",
      detail: "USE",
    });
    expect(url).toContain(encodeURIComponent("plan"));
    expect(url).toContain(encodeURIComponent("USE"));
    expect(url).not.toContain(encodeURIComponent('cy="44"'));
  });
});

describe("cyclePlanMode", () => {
  const keys: PlanMetricKey[] = ["fiveHour", "sevenDay", "extraUsage"];

  test("cycles forward through the given metric keys", () => {
    expect(cyclePlanMode(keys, "fiveHour")).toBe("sevenDay");
    expect(cyclePlanMode(keys, "sevenDay")).toBe("extraUsage");
  });

  test("wraps at the end", () => {
    expect(cyclePlanMode(keys, "extraUsage")).toBe("fiveHour");
  });

  test("unknown current falls back to first", () => {
    expect(cyclePlanMode(keys, "extraUsage")).toBe("fiveHour");
  });

  test("empty list returns the same key", () => {
    expect(cyclePlanMode([], "fiveHour")).toBe("fiveHour");
  });
});
