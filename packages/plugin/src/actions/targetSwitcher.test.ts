import { describe, expect, test } from "bun:test";
import { cycleTargetFilter, renderTargetSwitcher } from "./targetSwitcher";

describe("renderTargetSwitcher", () => {
  test("null filter renders the ALL sentinel", () => {
    expect(renderTargetSwitcher(null)).toEqual({ title: "ALL" });
  });

  test("a chosen target renders its name", () => {
    expect(renderTargetSwitcher("workbox")).toEqual({ title: "workbox" });
  });

  test("long target names truncate to 10 chars (mirrors agentSlot's budget)", () => {
    expect(renderTargetSwitcher("a-very-long-target-name")).toEqual({ title: "a-very-lon" });
  });
});

describe("cycleTargetFilter", () => {
  const names = ["local", "workbox", "other"];

  test("all → first target", () => {
    expect(cycleTargetFilter(null, names)).toBe("local");
  });

  test("advances through targets in order", () => {
    expect(cycleTargetFilter("local", names)).toBe("workbox");
    expect(cycleTargetFilter("workbox", names)).toBe("other");
  });

  test("wraps from the last target back to all (null)", () => {
    expect(cycleTargetFilter("other", names)).toBeNull();
  });

  test("unknown current target falls back to the first target", () => {
    expect(cycleTargetFilter("gone", names)).toBe("local");
  });

  test("empty target list always yields null", () => {
    expect(cycleTargetFilter(null, [])).toBeNull();
    expect(cycleTargetFilter("local", [])).toBeNull();
  });

  test("single target cycles all → target → all", () => {
    expect(cycleTargetFilter(null, ["local"])).toBe("local");
    expect(cycleTargetFilter("local", ["local"])).toBeNull();
  });
});
