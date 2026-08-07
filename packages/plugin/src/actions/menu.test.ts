import { describe, expect, test } from "bun:test";
import { renderMenu } from "./menu";

describe("renderMenu — single page (no overflow)", () => {
  test("shows agent count in default view", () => {
    const out = renderMenu({ agentCount: 3, page: 0, pageCount: 1, bridgeState: "connected" });
    expect(out.title).toContain("3");
    expect(out.title.toLowerCase()).toContain("agnt");
    expect(out.title).toContain("MENU");
  });

  test("singular 'agnt' for exactly one agent", () => {
    const out = renderMenu({ agentCount: 1, page: 0, pageCount: 1, bridgeState: "connected" });
    expect(out.title).toContain("1 agnt\n");
  });

  test("disconnected state surfaces alert marker", () => {
    const out = renderMenu({ agentCount: 0, page: 0, pageCount: 1, bridgeState: "disconnected" });
    expect(out.title).toContain("‼");
    expect(out.alert).toBe(true);
  });

  test("connected state has no alert marker", () => {
    const out = renderMenu({ agentCount: 0, page: 0, pageCount: 1, bridgeState: "connected" });
    expect(out.title).not.toContain("‼");
    expect(out.alert).toBe(false);
  });
});

describe("renderMenu — paging (overflow)", () => {
  test("shows current page / page count when agents overflow visible slots", () => {
    const out = renderMenu({ agentCount: 12, page: 0, pageCount: 3, bridgeState: "connected" });
    expect(out.title).toContain("12 agnts");
    expect(out.title).toContain("PG 1/3");
  });

  test("page display is 1-indexed for the user even though the manager is 0-indexed", () => {
    const out = renderMenu({ agentCount: 12, page: 2, pageCount: 3, bridgeState: "connected" });
    expect(out.title).toContain("PG 3/3");
  });

  test("alert marker still applies while paging and disconnected", () => {
    const out = renderMenu({ agentCount: 12, page: 1, pageCount: 3, bridgeState: "disconnected" });
    expect(out.title).toContain("‼");
    expect(out.title).toContain("PG 2/3");
  });
});
