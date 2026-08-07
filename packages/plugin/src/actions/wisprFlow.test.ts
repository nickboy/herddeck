import { describe, expect, test } from "bun:test";
import { renderWisprFlow } from "./wisprFlow";

describe("renderWisprFlow", () => {
  test("returns a stable static title (button face never changes)", () => {
    expect(renderWisprFlow("connected")).toEqual({ title: "wispr\nflow" });
  });

  test("prefixes the title with `!` when the bridge is offline", () => {
    // Mirrors the convention used by answer keys: when the bridge is
    // down a press cannot reach the daemon, so the user sees a `!`
    // prefix indicating "won't fire". Same affordance for the
    // wispr-flow key keeps the diagnostic consistent.
    expect(renderWisprFlow("disconnected").title.startsWith("!")).toBe(true);
    expect(renderWisprFlow("connecting").title.startsWith("!")).toBe(true);
  });
});
