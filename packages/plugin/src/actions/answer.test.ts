import { describe, expect, test } from "bun:test";
import { renderAnswerKey } from "./answer";

describe("renderAnswerKey", () => {
  test("dim label when nothing is focused", () => {
    expect(renderAnswerKey("yes", undefined)).toEqual({ title: "YES", highlight: false });
    expect(renderAnswerKey("no", undefined)).toEqual({ title: "NO", highlight: false });
    expect(renderAnswerKey("always", undefined)).toEqual({ title: "ALL", highlight: false });
  });

  test("dim label when focused agent is not blocked (nothing to answer)", () => {
    const focused = { target: "local", paneId: "abcd1234", status: "working" as const };
    expect(renderAnswerKey("yes", focused)).toEqual({ title: "YES", highlight: false });
  });

  test("lit with target tag when focused agent is blocked", () => {
    const focused = { target: "local", paneId: "abcd1234", status: "blocked" as const };
    const yes = renderAnswerKey("yes", focused);
    expect(yes.highlight).toBe(true);
    expect(yes.title).toContain("YES");
    expect(yes.title).toContain("1234"); // last 4 chars of paneId
  });

  test("blocked focus with short paneId uses the whole id", () => {
    const focused = { target: "local", paneId: "p1", status: "blocked" as const };
    expect(renderAnswerKey("always", focused).title).toContain("p1");
  });

  test("return is stable across calls", () => {
    const focused = { target: "local", paneId: "abcd", status: "blocked" as const };
    const a = renderAnswerKey("yes", focused);
    const b = renderAnswerKey("yes", focused);
    expect(a).toEqual(b);
  });

  test("disconnected bridge prefixes label with '!' (no focus)", () => {
    expect(renderAnswerKey("yes", undefined, "disconnected").title).toBe("!YES");
    expect(renderAnswerKey("no", undefined, "connecting").title).toBe("!NO");
    expect(renderAnswerKey("always", undefined, "connected").title).toBe("ALL");
  });

  test("disconnected bridge prefixes label with '!' (blocked focus)", () => {
    const focused = { target: "local", paneId: "abcd1234", status: "blocked" as const };
    const yes = renderAnswerKey("yes", focused, "disconnected");
    expect(yes.title.startsWith("!YES")).toBe(true);
    expect(yes.title).toContain("1234");
    expect(yes.highlight).toBe(true);
  });

  test("default bridgeState treats missing arg as connected", () => {
    expect(renderAnswerKey("yes", undefined).title).toBe("YES");
  });
});
