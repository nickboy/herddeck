import { describe, expect, mock, test } from "bun:test";
import { AgentSlotManager, sameAgent, slotFromCoordinates } from "./agentSlots";
import type { AgentSnapshot } from "./wire";

const makeAgent = (
  target: string,
  paneId: string,
  overrides: Partial<AgentSnapshot> = {},
): AgentSnapshot => ({
  target,
  paneId,
  name: null,
  agentKind: "claude",
  status: "idle",
  workspaceLabel: null,
  cwd: `/tmp/${paneId}`,
  title: null,
  ctxPct: null,
  stateChangeSeq: 1,
  ...overrides,
});

describe("sameAgent", () => {
  test("true when target and paneId match", () => {
    expect(sameAgent({ target: "local", paneId: "p1" }, { target: "local", paneId: "p1" })).toBe(
      true,
    );
  });

  test("false on any field mismatch", () => {
    expect(sameAgent({ target: "local", paneId: "p1" }, { target: "local", paneId: "p2" })).toBe(
      false,
    );
    expect(sameAgent({ target: "local", paneId: "p1" }, { target: "remote", paneId: "p1" })).toBe(
      false,
    );
  });

  test("false when either side is undefined", () => {
    expect(sameAgent(undefined, { target: "local", paneId: "p1" })).toBe(false);
    expect(sameAgent({ target: "local", paneId: "p1" }, undefined)).toBe(false);
    expect(sameAgent(undefined, undefined)).toBe(false);
  });
});

describe("AgentSlotManager.setAgents / agentAt", () => {
  test("places agents into slots in daemon order (no re-sorting)", () => {
    const mgr = new AgentSlotManager();
    const a = makeAgent("local", "p1");
    const b = makeAgent("local", "p2");
    mgr.setAgents([a, b]);
    expect(mgr.agentAt(0)).toEqual(a);
    expect(mgr.agentAt(1)).toEqual(b);
    expect(mgr.agentAt(2)).toBeUndefined();
    expect(mgr.size()).toBe(2);
  });

  test("agentAt is undefined for out-of-range slot index", () => {
    const mgr = new AgentSlotManager();
    mgr.setAgents([makeAgent("local", "p1")]);
    expect(mgr.agentAt(-1)).toBeUndefined();
    expect(mgr.agentAt(5)).toBeUndefined();
    expect(mgr.agentAt(99)).toBeUndefined();
  });

  test("setAgents replaces the whole list wholesale (no per-agent upsert)", () => {
    const mgr = new AgentSlotManager();
    mgr.setAgents([makeAgent("local", "p1"), makeAgent("local", "p2")]);
    mgr.setAgents([makeAgent("local", "p3")]);
    expect(mgr.size()).toBe(1);
    expect(mgr.agentAt(0)?.paneId).toBe("p3");
    expect(mgr.agentAt(1)).toBeUndefined();
  });

  test("list() returns agents in the exact order given", () => {
    const mgr = new AgentSlotManager();
    const agents = [makeAgent("local", "p3"), makeAgent("local", "p1"), makeAgent("local", "p2")];
    mgr.setAgents(agents);
    expect(mgr.list().map((a) => a.paneId)).toEqual(["p3", "p1", "p2"]);
  });
});

describe("AgentSlotManager paging", () => {
  test("pageCount is 1 when everything fits in maxSlots", () => {
    const mgr = new AgentSlotManager({ maxSlots: 5 });
    mgr.setAgents([makeAgent("local", "p1"), makeAgent("local", "p2")]);
    expect(mgr.pageCount()).toBe(1);
    expect(mgr.currentPage()).toBe(0);
  });

  test("pageCount is 1 even with zero agents", () => {
    const mgr = new AgentSlotManager();
    expect(mgr.pageCount()).toBe(1);
  });

  test("pageCount grows when agents overflow maxSlots", () => {
    const mgr = new AgentSlotManager({ maxSlots: 2 });
    mgr.setAgents([
      makeAgent("local", "p1"),
      makeAgent("local", "p2"),
      makeAgent("local", "p3"),
      makeAgent("local", "p4"),
      makeAgent("local", "p5"),
    ]);
    expect(mgr.pageCount()).toBe(3); // ceil(5/2)
  });

  test("nextPage cycles forward and wraps around", () => {
    const mgr = new AgentSlotManager({ maxSlots: 2 });
    mgr.setAgents([
      makeAgent("local", "p1"),
      makeAgent("local", "p2"),
      makeAgent("local", "p3"),
      makeAgent("local", "p4"),
      makeAgent("local", "p5"),
    ]);
    expect(mgr.currentPage()).toBe(0);
    mgr.nextPage();
    expect(mgr.currentPage()).toBe(1);
    mgr.nextPage();
    expect(mgr.currentPage()).toBe(2);
    mgr.nextPage();
    expect(mgr.currentPage()).toBe(0);
  });

  test("nextPage is a no-op (stays put) when only one page exists", () => {
    const mgr = new AgentSlotManager({ maxSlots: 5 });
    mgr.setAgents([makeAgent("local", "p1")]);
    mgr.nextPage();
    expect(mgr.currentPage()).toBe(0);
  });

  test("agentAt reflects the current page's offset", () => {
    const mgr = new AgentSlotManager({ maxSlots: 2 });
    const agents = [makeAgent("local", "p1"), makeAgent("local", "p2"), makeAgent("local", "p3")];
    mgr.setAgents(agents);
    mgr.nextPage();
    expect(mgr.currentPage()).toBe(1);
    expect(mgr.agentAt(0)?.paneId).toBe("p3");
    expect(mgr.agentAt(1)).toBeUndefined();
  });

  test("setAgents clamps the page back into range when the list shrinks", () => {
    const mgr = new AgentSlotManager({ maxSlots: 2 });
    mgr.setAgents([
      makeAgent("local", "p1"),
      makeAgent("local", "p2"),
      makeAgent("local", "p3"),
      makeAgent("local", "p4"),
    ]);
    mgr.nextPage();
    expect(mgr.currentPage()).toBe(1);
    mgr.setAgents([makeAgent("local", "p1")]); // now only 1 page
    expect(mgr.currentPage()).toBe(0);
    expect(mgr.agentAt(0)?.paneId).toBe("p1");
  });
});

describe("AgentSlotManager focus tracking", () => {
  test("getFocused is undefined until set", () => {
    const mgr = new AgentSlotManager();
    expect(mgr.getFocused()).toBeUndefined();
  });

  test("setFocused / getFocused / isFocused round-trip", () => {
    const mgr = new AgentSlotManager();
    mgr.setFocused({ target: "local", paneId: "p1" });
    expect(mgr.getFocused()).toEqual({ target: "local", paneId: "p1" });
    expect(mgr.isFocused({ target: "local", paneId: "p1" })).toBe(true);
    expect(mgr.isFocused({ target: "local", paneId: "p2" })).toBe(false);
  });

  test("setFocused(undefined) clears focus", () => {
    const mgr = new AgentSlotManager();
    mgr.setFocused({ target: "local", paneId: "p1" });
    mgr.setFocused(undefined);
    expect(mgr.getFocused()).toBeUndefined();
  });

  test("getFocusedAgent resolves the live snapshot for the focused key", () => {
    const mgr = new AgentSlotManager();
    const agent = makeAgent("local", "p1", { status: "blocked" });
    mgr.setAgents([agent]);
    mgr.setFocused({ target: "local", paneId: "p1" });
    expect(mgr.getFocusedAgent()).toEqual(agent);
  });

  test("getFocusedAgent is undefined when nothing is focused", () => {
    const mgr = new AgentSlotManager();
    mgr.setAgents([makeAgent("local", "p1")]);
    expect(mgr.getFocusedAgent()).toBeUndefined();
  });

  test("setAgents clears focus and emits 'focus-lost' when the focused agent disappears", () => {
    const mgr = new AgentSlotManager();
    mgr.setAgents([makeAgent("local", "p1")]);
    mgr.setFocused({ target: "local", paneId: "p1" });
    const listener = mock();
    mgr.on("focus-lost", listener);
    mgr.setAgents([makeAgent("local", "p2")]);
    expect(mgr.getFocused()).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("setAgents keeps focus (no event) when the focused agent is still present", () => {
    const mgr = new AgentSlotManager();
    mgr.setAgents([makeAgent("local", "p1")]);
    mgr.setFocused({ target: "local", paneId: "p1" });
    const listener = mock();
    mgr.on("focus-lost", listener);
    mgr.setAgents([makeAgent("local", "p1", { status: "working" })]);
    expect(mgr.getFocused()).toEqual({ target: "local", paneId: "p1" });
    expect(listener).not.toHaveBeenCalled();
  });

  test("setAgents on an empty->empty transition does not spuriously fire 'focus-lost'", () => {
    const mgr = new AgentSlotManager();
    const listener = mock();
    mgr.on("focus-lost", listener);
    mgr.setAgents([]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("AgentSlotManager target filter", () => {
  test("targetFilter defaults to null (all targets)", () => {
    const mgr = new AgentSlotManager();
    expect(mgr.targetFilter()).toBeNull();
  });

  test("visibleAgents returns the full list when filter is null", () => {
    const mgr = new AgentSlotManager();
    const agents = [makeAgent("local", "p1"), makeAgent("workbox", "p2")];
    mgr.setAgents(agents);
    expect(mgr.visibleAgents()).toEqual(agents);
  });

  test("visibleAgents narrows to the filtered target", () => {
    const mgr = new AgentSlotManager();
    const local1 = makeAgent("local", "p1");
    const local2 = makeAgent("local", "p2");
    const remote = makeAgent("workbox", "p3");
    mgr.setAgents([local1, remote, local2]);
    mgr.setTargetFilter("local");
    expect(mgr.visibleAgents()).toEqual([local1, local2]);
  });

  test("size/pageCount/agentAt read through the filter", () => {
    const mgr = new AgentSlotManager({ maxSlots: 2 });
    mgr.setAgents([
      makeAgent("local", "p1"),
      makeAgent("workbox", "p2"),
      makeAgent("local", "p3"),
      makeAgent("local", "p4"),
    ]);
    mgr.setTargetFilter("local");
    expect(mgr.size()).toBe(3);
    expect(mgr.pageCount()).toBe(2); // ceil(3/2)
    expect(mgr.agentAt(0)?.paneId).toBe("p1");
    expect(mgr.agentAt(1)?.paneId).toBe("p3");
  });

  test("setTargetFilter resets to page 0", () => {
    const mgr = new AgentSlotManager({ maxSlots: 1 });
    mgr.setAgents([makeAgent("local", "p1"), makeAgent("local", "p2")]);
    mgr.nextPage();
    expect(mgr.currentPage()).toBe(1);
    mgr.setTargetFilter("local");
    expect(mgr.currentPage()).toBe(0);
  });

  test("setTargetFilter(null) clears the filter back to all targets", () => {
    const mgr = new AgentSlotManager();
    mgr.setAgents([makeAgent("local", "p1"), makeAgent("workbox", "p2")]);
    mgr.setTargetFilter("local");
    expect(mgr.size()).toBe(1);
    mgr.setTargetFilter(null);
    expect(mgr.size()).toBe(2);
    expect(mgr.targetFilter()).toBeNull();
  });

  test("filtering out the focused agent does not clear focus", () => {
    const mgr = new AgentSlotManager();
    mgr.setAgents([makeAgent("local", "p1"), makeAgent("workbox", "p2")]);
    mgr.setFocused({ target: "workbox", paneId: "p2" });
    const listener = mock();
    mgr.on("focus-lost", listener);
    mgr.setTargetFilter("local");
    expect(mgr.getFocused()).toEqual({ target: "workbox", paneId: "p2" });
    expect(mgr.getFocusedAgent()?.paneId).toBe("p2");
    expect(listener).not.toHaveBeenCalled();
  });

  test("list() stays unfiltered regardless of the target filter", () => {
    const mgr = new AgentSlotManager();
    const agents = [makeAgent("local", "p1"), makeAgent("workbox", "p2")];
    mgr.setAgents(agents);
    mgr.setTargetFilter("local");
    expect(mgr.list()).toEqual(agents);
  });
});

describe("slotFromCoordinates", () => {
  test("row 0, columns 0-4 map to slots 0-4", () => {
    for (let col = 0; col <= 4; col++) {
      expect(slotFromCoordinates({ column: col, row: 0 })).toBe(col);
    }
  });

  test("any other row returns undefined", () => {
    expect(slotFromCoordinates({ column: 0, row: 1 })).toBeUndefined();
    expect(slotFromCoordinates({ column: 0, row: 2 })).toBeUndefined();
  });

  test("out-of-range column returns undefined", () => {
    expect(slotFromCoordinates({ column: -1, row: 0 })).toBeUndefined();
    expect(slotFromCoordinates({ column: 5, row: 0 })).toBeUndefined();
  });

  test("undefined coordinates returns undefined", () => {
    expect(slotFromCoordinates(undefined)).toBeUndefined();
  });
});
