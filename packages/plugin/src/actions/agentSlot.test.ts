import { describe, expect, test } from "bun:test";
import type { AgentSnapshot, AgentStatus } from "../wire";
import { EMPTY_SLOT_BG, STATUS_COLOURS, renderAgentSlot, renderAgentSlotImage } from "./agentSlot";

const makeAgent = (overrides: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  target: "local",
  paneId: "p1",
  name: null,
  agentKind: "claude",
  status: "idle",
  workspaceLabel: null,
  cwd: "/home/nick/project",
  title: null,
  tabLabel: null,
  ctxPct: null,
  stateChangeSeq: 1,
  ...overrides,
});

describe("renderAgentSlot — empty slot", () => {
  test("no agent renders empty/dim background with no title", () => {
    const r = renderAgentSlot(undefined, false, false);
    expect(r.title).toBe("");
    expect(r.backgroundHex).toBe(EMPTY_SLOT_BG);
    expect(r.dim).toBe(true);
    expect(r.pulse).toBe(false);
  });

  test("no agent ignores focused flag", () => {
    const r = renderAgentSlot(undefined, true, false);
    expect(r.title).toBe("");
    expect(r.dim).toBe(true);
  });
});

describe("renderAgentSlot — status → colour mapping", () => {
  const cases: Array<[AgentStatus, string, boolean]> = [
    ["idle", STATUS_COLOURS.idle, false],
    ["working", STATUS_COLOURS.working, false],
    ["blocked", STATUS_COLOURS.blocked, true],
    ["done", STATUS_COLOURS.done, false],
    ["unknown", STATUS_COLOURS.unknown, false],
    ["offline", STATUS_COLOURS.offline, false],
  ];

  for (const [status, expectedHex, expectedPulse] of cases) {
    test(`status=${status} → bg ${expectedHex}, pulse=${expectedPulse}`, () => {
      const r = renderAgentSlot(makeAgent({ status }), false, false);
      expect(r.backgroundHex).toBe(expectedHex);
      expect(r.pulse).toBe(expectedPulse);
      expect(r.dim).toBe(false);
    });
  }

  test("status palette uses the exact Catppuccin Mocha hexes from docs/CONTRACTS.md", () => {
    expect(STATUS_COLOURS.blocked).toBe("#f38ba8");
    expect(STATUS_COLOURS.working).toBe("#f9e2af");
    expect(STATUS_COLOURS.done).toBe("#a6e3a1");
    expect(STATUS_COLOURS.idle).toBe("#6c7086");
    expect(STATUS_COLOURS.unknown).toBe("#6c7086");
    expect(STATUS_COLOURS.offline).toBe("#45475a");
  });
});

describe("renderAgentSlotImage — SVG data URL", () => {
  test("returns an SVG data URL (url-encoded)", () => {
    const url = renderAgentSlotImage({ backgroundHex: "#a6e3a1", dim: false });
    expect(url.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    const decoded = decodeURIComponent(url.slice("data:image/svg+xml;utf8,".length));
    expect(decoded).toContain('viewBox="0 0 72 72"');
    expect(decoded).toContain('fill="#a6e3a1"');
  });

  test("dim (empty slot) overlays the >_ prompt glyph", () => {
    const url = renderAgentSlotImage({ backgroundHex: EMPTY_SLOT_BG, dim: true });
    const decoded = decodeURIComponent(url.slice("data:image/svg+xml;utf8,".length));
    expect(decoded).toContain("&gt;_");
  });

  test("non-dim (active agent) shows only the color swatch, no glyph", () => {
    const url = renderAgentSlotImage({ backgroundHex: STATUS_COLOURS.working, dim: false });
    const decoded = decodeURIComponent(url.slice("data:image/svg+xml;utf8,".length));
    expect(decoded).not.toContain("&gt;_");
  });
});

describe("renderAgentSlot — title resolution (name > tabLabel > workspaceLabel > cwd basename)", () => {
  test("falls back to cwd basename when name, tabLabel, and workspaceLabel are null", () => {
    const r = renderAgentSlot(makeAgent({ cwd: "/home/nick/project" }), false, false);
    expect(r.displayName).toBe("project");
  });

  test("prefers workspaceLabel over cwd basename", () => {
    const r = renderAgentSlot(
      makeAgent({ cwd: "/home/nick/project", workspaceLabel: "main" }),
      false,
      false,
    );
    expect(r.displayName).toBe("main");
  });

  test("prefers tabLabel over workspaceLabel and cwd basename", () => {
    const r = renderAgentSlot(
      makeAgent({ cwd: "/home/nick/project", workspaceLabel: "main", tabLabel: "Herddeck" }),
      false,
      false,
    );
    expect(r.displayName).toBe("Herddeck");
  });

  test("falls through to workspaceLabel when tabLabel is null", () => {
    const r = renderAgentSlot(
      makeAgent({ cwd: "/home/nick/project", workspaceLabel: "main", tabLabel: null }),
      false,
      false,
    );
    expect(r.displayName).toBe("main");
  });

  test("prefers agent name over tabLabel, workspaceLabel, and cwd basename", () => {
    const r = renderAgentSlot(
      makeAgent({
        cwd: "/home/nick/project",
        workspaceLabel: "main",
        tabLabel: "Herddeck",
        name: "builder",
      }),
      false,
      false,
    );
    expect(r.displayName).toBe("builder");
  });

  test("title handles trailing slashes in cwd", () => {
    const r = renderAgentSlot(makeAgent({ cwd: "/home/nick/project/" }), false, false);
    expect(r.displayName).toBe("project");
  });

  test("displayName truncates to 10 chars", () => {
    const r = renderAgentSlot(makeAgent({ cwd: "/tmp/this-is-a-very-long-dirname" }), false, false);
    expect(r.displayName).toBe("this-is-a-");
    expect(r.displayName?.length).toBe(10);
  });

  test("displayName prepends focus arrow when focused", () => {
    const r = renderAgentSlot(makeAgent({ cwd: "/x/foo" }), true, false);
    expect(r.displayName).toBe("▸ foo");
  });

  test("displayName does NOT prepend focus arrow when not focused", () => {
    const r = renderAgentSlot(makeAgent({ cwd: "/x/foo" }), false, false);
    expect(r.displayName).toBe("foo");
  });

  test("displayName handles empty cwd and no name/label", () => {
    const r = renderAgentSlot(makeAgent({ cwd: "" }), false, false);
    expect(r.displayName).toBe("");
  });

  test("SDK title is always empty for active slots (we draw name in SVG ourselves)", () => {
    const r = renderAgentSlot(makeAgent({ cwd: "/x/foo" }), false, false);
    expect(r.title).toBe("");
  });
});

describe("renderAgentSlot — target suffix (multi-target only)", () => {
  test("no suffix when only one target is configured", () => {
    const r = renderAgentSlot(makeAgent({ target: "workbox" }), false, false);
    expect(r.targetSuffix).toBeUndefined();
  });

  test("suffix shows the target name when multiTarget is true", () => {
    const r = renderAgentSlot(makeAgent({ target: "workbox" }), false, true);
    expect(r.targetSuffix).toBe("workbox");
  });

  test("suffix truncates long target names to 8 chars", () => {
    const r = renderAgentSlot(makeAgent({ target: "a-very-long-target-name" }), false, true);
    expect(r.targetSuffix).toBe("a-very-l");
  });

  test("empty slot never gets a target suffix", () => {
    const r = renderAgentSlot(undefined, false, true);
    expect(r.targetSuffix).toBeUndefined();
  });
});

describe("renderAgentSlot — pureness", () => {
  test("returns stable output for the same input", () => {
    const agent = makeAgent({ status: "working" });
    expect(renderAgentSlot(agent, false, false)).toEqual(renderAgentSlot(agent, false, false));
  });

  test("does not mutate the input agent", () => {
    const agent = makeAgent({ status: "blocked" });
    const before = JSON.parse(JSON.stringify(agent));
    renderAgentSlot(agent, true, true);
    expect(agent).toEqual(before);
  });
});

describe("renderAgentSlot — context-window indicator (ctxPct)", () => {
  test("displayName present without context (full 10-char budget)", () => {
    const r = renderAgentSlot(makeAgent({ cwd: "/home/nick/myproj" }), false, false);
    expect(r.displayName).toBe("myproj");
    expect(r.contextFillPercent).toBeUndefined();
    expect(r.contextFillColor).toBeUndefined();
  });

  test("displayName + donut both rendered when ctxPct present", () => {
    const r = renderAgentSlot(makeAgent({ cwd: "/home/nick/myproj", ctxPct: 45 }), false, false);
    expect(r.displayName).toBe("myproj");
    expect(r.contextFillPercent).toBe(45);
  });

  test("name budget tightens to 8 chars when ctxPct present", () => {
    const r = renderAgentSlot(makeAgent({ cwd: "/home/nick/longname1", ctxPct: 45 }), false, false);
    expect(r.displayName).toBe("longname");
  });

  test("threshold colors: green <50%, yellow 50-79%, red >=80%", () => {
    expect(renderAgentSlot(makeAgent({ ctxPct: 0 }), false, false).contextFillColor).toBe(
      "#94e2d5",
    );
    expect(renderAgentSlot(makeAgent({ ctxPct: 49 }), false, false).contextFillColor).toBe(
      "#94e2d5",
    );
    expect(renderAgentSlot(makeAgent({ ctxPct: 50 }), false, false).contextFillColor).toBe(
      "#f9e2af",
    );
    expect(renderAgentSlot(makeAgent({ ctxPct: 80 }), false, false).contextFillColor).toBe(
      "#f38ba8",
    );
  });
});

describe("renderAgentSlotImage — context donut", () => {
  test("no donut when contextFillPercent undefined", () => {
    const url = renderAgentSlotImage({ backgroundHex: "#f9e2af", dim: false });
    expect(url).not.toContain(encodeURIComponent('cy="44"'));
  });

  test("donut SVG includes the threshold color when percent present", () => {
    const url = renderAgentSlotImage({
      backgroundHex: "#f9e2af",
      dim: false,
      contextFillPercent: 60,
      contextFillColor: "#f9e2af",
    });
    expect(url).toContain(encodeURIComponent("#f9e2af"));
    expect(url).toContain(encodeURIComponent('cy="44"'));
    expect(url).toContain(encodeURIComponent('r="18"'));
    expect(url).toContain(encodeURIComponent("60%"));
  });

  test("dim (empty slot) suppresses the donut even with a percent supplied", () => {
    const url = renderAgentSlotImage({
      backgroundHex: EMPTY_SLOT_BG,
      dim: true,
      contextFillPercent: 60,
      contextFillColor: "#f9e2af",
    });
    expect(url).not.toContain(encodeURIComponent("#f9e2af"));
    expect(url).not.toContain(encodeURIComponent('cy="44"'));
  });
});

describe("renderAgentSlotImage — target suffix", () => {
  test("suffix text included when present", () => {
    const url = renderAgentSlotImage({
      backgroundHex: "#6c7086",
      dim: false,
      displayName: "proj",
      targetSuffix: "workbox",
    });
    expect(url).toContain(encodeURIComponent("workbox"));
  });

  test("no suffix markup when absent", () => {
    const url = renderAgentSlotImage({ backgroundHex: "#6c7086", dim: false, displayName: "proj" });
    const decoded = decodeURIComponent(url.slice("data:image/svg+xml;utf8,".length));
    // Only one <text> for the name — no second small suffix text.
    expect((decoded.match(/<text/g) ?? []).length).toBe(1);
  });

  test("dim (empty slot) never renders a suffix even if one were supplied", () => {
    const url = renderAgentSlotImage({
      backgroundHex: EMPTY_SLOT_BG,
      dim: true,
      targetSuffix: "workbox",
    });
    expect(url).not.toContain(encodeURIComponent("workbox"));
  });
});

describe("renderAgentSlot — live terminal title", () => {
  test("terminal title outranks tab label (it follows /rename live)", () => {
    const r = renderAgentSlot(
      makeAgent({ name: null, title: "herdr-limit", tabLabel: "workspace" }),
      false,
      false,
    );
    // 10-char key budget clips the tail; the point is which source won.
    expect(r.displayName).toContain("herdr-lim");
    expect(r.displayName).not.toContain("workspace");
  });

  test("falls back to the tab label when no terminal title", () => {
    const r = renderAgentSlot(
      makeAgent({ name: null, title: null, tabLabel: "Dotfiles" }),
      false,
      false,
    );
    expect(r.displayName).toContain("Dotfiles");
  });

  test("an explicit agent name still wins", () => {
    const r = renderAgentSlot(makeAgent({ name: "alpha", title: "herdr-limit" }), false, false);
    expect(r.displayName).toContain("alpha");
  });
});
