import { describe, expect, test } from "bun:test";
import type { TargetSnapshot } from "../wire";
import { renderWorktree, resolveWorktreeTarget } from "./worktree";

describe("renderWorktree", () => {
  test("idle, connected → empty title (icon carries the meaning)", () => {
    expect(renderWorktree(false, "connected")).toEqual({ title: "" });
  });

  test("idle, disconnected → '!' marker, same convention as the other command keys", () => {
    expect(renderWorktree(false, "disconnected")).toEqual({ title: "!" });
    expect(renderWorktree(false, "connecting")).toEqual({ title: "!" });
  });

  test("pending shows the brief in-flight glyph", () => {
    expect(renderWorktree(true, "connected")).toEqual({ title: "…" });
  });

  test("pending + disconnected combines both markers", () => {
    expect(renderWorktree(true, "disconnected")).toEqual({ title: "!…" });
  });

  test("defaults bridgeState to connected when omitted", () => {
    expect(renderWorktree(false)).toEqual({ title: "" });
  });
});

describe("resolveWorktreeTarget", () => {
  const online = (name: string): TargetSnapshot => ({
    name,
    kind: "local",
    state: "online",
    protocol: 19,
  });

  test("prefers the focused agent's target over any target list", () => {
    expect(resolveWorktreeTarget({ target: "workbox" }, [online("local")])).toBe("workbox");
  });

  test("falls back to the first ONLINE target when nothing is focused", () => {
    const targets: TargetSnapshot[] = [
      { name: "local", kind: "local", state: "connecting", protocol: null },
      { name: "workbox", kind: "remote", state: "online", protocol: 19 },
      { name: "other", kind: "remote", state: "online", protocol: 19 },
    ];
    expect(resolveWorktreeTarget(undefined, targets)).toBe("workbox");
  });

  test("skips offline/connecting/protocol-mismatch targets", () => {
    const targets: TargetSnapshot[] = [
      { name: "local", kind: "local", state: "offline", protocol: null },
      { name: "workbox", kind: "remote", state: "protocol-mismatch", protocol: 3 },
    ];
    expect(resolveWorktreeTarget(undefined, targets)).toBeUndefined();
  });

  test("undefined when nothing is focused and no target is online", () => {
    expect(resolveWorktreeTarget(undefined, [])).toBeUndefined();
  });
});
