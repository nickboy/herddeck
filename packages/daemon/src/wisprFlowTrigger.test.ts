import { describe, expect, test } from "bun:test";
import { runTrigger } from "./wisprFlowTrigger";

describe("runTrigger", () => {
  test("start action invokes `open -g wispr-flow://start-hands-free`", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeSpawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {},
        unref: () => {},
      };
    }) as unknown as typeof import("node:child_process").spawn;

    runTrigger("start", { spawnImpl: fakeSpawn });

    // -g flag is critical: without it, `open` brings Wispr Flow to
    // foreground and steals focus from whatever the user was typing in.
    expect(calls).toEqual([{ cmd: "open", args: ["-g", "wispr-flow://start-hands-free"] }]);
  });

  test("stop action invokes `open -g wispr-flow://stop-hands-free`", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeSpawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {},
        unref: () => {},
      };
    }) as unknown as typeof import("node:child_process").spawn;

    runTrigger("stop", { spawnImpl: fakeSpawn });

    expect(calls).toEqual([{ cmd: "open", args: ["-g", "wispr-flow://stop-hands-free"] }]);
  });

  test("does not throw when spawn itself throws synchronously", () => {
    // Mirrors ghosttyFocus.runJump — the WS message loop must not
    // be taken down by a missing `open` binary or sandbox refusal.
    const fakeSpawn = (() => {
      throw new Error("ENOENT open");
    }) as unknown as typeof import("node:child_process").spawn;

    expect(() => runTrigger("start", { spawnImpl: fakeSpawn })).not.toThrow();
  });

  test("does not throw when the spawned process emits an error event", () => {
    // Process-level errors (e.g. Wispr Flow not installed → `open`
    // exits non-zero) are logged, not thrown.
    const fakeSpawn = (() => {
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, cb: (...args: unknown[]) => void) => {
          if (event === "error") cb(new Error("spawn error"));
        },
        unref: () => {},
      };
    }) as unknown as typeof import("node:child_process").spawn;

    expect(() => runTrigger("stop", { spawnImpl: fakeSpawn })).not.toThrow();
  });
});
