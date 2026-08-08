// SessionRegistry first-attempt tunnel retry (R1): transient tunnel
// failures are retried on capped backoff by re-calling
// localSocketFor(); non-transient ones stay permanently offline. The
// classification is surfaced via TargetSnapshot.detail.

import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import type { HerdDeckConfig, TargetConfig } from "./config";
import { type RegistryEvents, SessionRegistry, type TunnelProvider } from "./registry";
import { TunnelError } from "./tunnel";
import type { TargetSnapshot } from "./wire";

type RemoteTarget = TargetConfig & { kind: "remote" };

/** Scripted TunnelProvider: each localSocketFor() call consumes the
 * next outcome; the last outcome repeats if calls keep coming. */
class StubTunnels implements TunnelProvider {
  calls = 0;
  stopCalled = false;

  constructor(private outcomes: Array<TunnelError | string>) {}

  localSocketFor(_target: RemoteTarget): Promise<string> {
    const outcome = this.outcomes[Math.min(this.calls, this.outcomes.length - 1)];
    this.calls++;
    if (outcome instanceof TunnelError) return Promise.reject(outcome);
    if (outcome === undefined) return Promise.reject(new Error("no outcome scripted"));
    return Promise.resolve(outcome);
  }

  stop(): void {
    this.stopCalled = true;
  }
}

function remoteConfig(name = "workbox"): HerdDeckConfig {
  return {
    port: 0,
    terminalApp: "Ghostty",
    planUsageEnabled: false,
    targets: [
      {
        name,
        kind: "remote",
        host: "workbox",
        remoteSocket: "/home/u/herdr.sock",
        focusTerminal: true,
      },
    ],
  };
}

function collectEvents(): { events: RegistryEvents; targets: TargetSnapshot[][] } {
  const targets: TargetSnapshot[][] = [];
  return {
    targets,
    events: {
      targetsChanged: (t) => targets.push(t),
      agentsChanged: () => {},
    },
  };
}

function lastSnapshot(targets: TargetSnapshot[][], name: string): TargetSnapshot | undefined {
  return targets.at(-1)?.find((t) => t.name === name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

// A path that exists in no test: TargetMonitor will just see
// ECONNREFUSED/ENOENT and report offline, which is fine — these tests
// only care that a monitor got attached at all.
const DEAD_SOCKET = path.join(os.tmpdir(), "herddeck-registry-test-nonexistent.sock");

describe("SessionRegistry tunnel retry", () => {
  test("transient failure => detail 'retrying', retry re-calls localSocketFor, success attaches monitor", async () => {
    const stub = new StubTunnels([new TunnelError("tunnel workbox: timed out", true), DEAD_SOCKET]);
    const { events, targets } = collectEvents();
    const registry = new SessionRegistry(remoteConfig(), events, stub, {
      log: () => {},
      tunnelRetryBaseMs: 20,
      tunnelRetryMaxMs: 100,
    });
    registry.start();

    await waitFor(() => lastSnapshot(targets, "workbox")?.detail === "retrying", 1000);
    const failed = lastSnapshot(targets, "workbox");
    expect(failed?.state).toBe("offline");
    expect(failed?.detail).toBe("retrying");
    expect(registry.monitorFor("workbox")).toBeNull();

    // Backoff (base 20ms, jittered 0.5–1.5x) fires => second attempt
    // succeeds => monitor attached, detail cleared.
    await waitFor(() => stub.calls >= 2, 2000);
    await waitFor(() => registry.monitorFor("workbox") !== null, 2000);
    expect(lastSnapshot(targets, "workbox")?.detail).toBeNull();

    registry.stop();
  });

  test("non-transient failure => detail 'auth', permanently offline, no retry", async () => {
    const stub = new StubTunnels([
      new TunnelError("tunnel workbox: Permission denied (publickey)", false),
    ]);
    const { events, targets } = collectEvents();
    const registry = new SessionRegistry(remoteConfig(), events, stub, {
      log: () => {},
      tunnelRetryBaseMs: 10,
      tunnelRetryMaxMs: 50,
    });
    registry.start();

    await waitFor(() => lastSnapshot(targets, "workbox")?.detail === "auth", 1000);
    expect(lastSnapshot(targets, "workbox")?.state).toBe("offline");

    // Far longer than any injected backoff — no retry may fire.
    await sleep(100);
    expect(stub.calls).toBe(1);
    expect(registry.monitorFor("workbox")).toBeNull();

    registry.stop();
  });

  test("unclassified (non-TunnelError) rejection is treated as non-transient", async () => {
    const stub = new StubTunnels([]);
    stub.localSocketFor = () => {
      stub.calls++;
      return Promise.reject(new Error("something exploded"));
    };
    const { events, targets } = collectEvents();
    const registry = new SessionRegistry(remoteConfig(), events, stub, {
      log: () => {},
      tunnelRetryBaseMs: 10,
      tunnelRetryMaxMs: 50,
    });
    registry.start();

    await waitFor(() => lastSnapshot(targets, "workbox")?.detail === "auth", 1000);
    await sleep(100);
    expect(stub.calls).toBe(1);

    registry.stop();
  });

  test("stop() cancels a pending retry and stops the tunnel provider", async () => {
    const stub = new StubTunnels([new TunnelError("tunnel workbox: refused", true)]);
    const { events, targets } = collectEvents();
    const registry = new SessionRegistry(remoteConfig(), events, stub, {
      log: () => {},
      tunnelRetryBaseMs: 50,
      tunnelRetryMaxMs: 200,
    });
    registry.start();

    await waitFor(() => lastSnapshot(targets, "workbox")?.detail === "retrying", 1000);
    expect(stub.calls).toBe(1);

    registry.stop();
    expect(stub.stopCalled).toBe(true);

    // Longer than max backoff — the cancelled timer must never fire.
    await sleep(350);
    expect(stub.calls).toBe(1);
  });

  test("local targets carry detail null", () => {
    const config: HerdDeckConfig = {
      port: 0,
      terminalApp: "Ghostty",
      planUsageEnabled: false,
      targets: [{ name: "here", kind: "local", socket: DEAD_SOCKET, focusTerminal: true }],
    };
    const { events, targets } = collectEvents();
    const registry = new SessionRegistry(config, events);
    registry.start();

    expect(lastSnapshot(targets, "here")?.detail).toBeNull();

    registry.stop();
  });
});
