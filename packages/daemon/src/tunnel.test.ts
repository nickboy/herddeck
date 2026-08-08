import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TargetConfig } from "./config";
import { TunnelError, TunnelManager } from "./tunnel";

// Fake ssh: a tiny Bun script written to disk per test run. It never
// touches a real remote host — it parses the same `-L local:remote`
// argv that TunnelManager builds, and (depending on a JSON "control
// file" whose path is smuggled through in the `host` argv slot)
// either binds a real unix socket at `local` and serves pong replies,
// or fails immediately with a chosen exit code/stderr, or binds then
// dies after a delay to simulate a dropped tunnel. Establish now ends
// with a ping probe THROUGH the socket, so the default "listen" mode
// answers any request line with a canned pong; "listen-mute" binds
// but never answers (simulating ssh bound locally with the remote
// side dead) and can emit control.stderrOnConnect to stderr when a
// client connects, mimicking ssh's async
// `connect to <path> port 0 failed` line. control.stderrBanner is
// written to stderr right after binding (exercises the lifetime
// stderr drain). It does NOT unlink a pre-existing file at `local`
// itself — that's TunnelManager's job (step 1 of establish); if
// TunnelManager skipped it, Bun.listen() binding on top of a stale
// plain file throws and the fake exits non-zero, which is what the
// "stale socket" test relies on.
const MOCK_SSH_SOURCE = `#!/usr/bin/env bun
import fs from "node:fs";

const args = process.argv.slice(2);
const lIdx = args.indexOf("-L");
const forward = lIdx >= 0 ? args[lIdx + 1] : undefined;
const colonIdx = forward ? forward.indexOf(":") : -1;
const localSock = forward && colonIdx >= 0 ? forward.slice(0, colonIdx) : undefined;
const controlPath = args[args.length - 1];

try {
  fs.appendFileSync(\`\${controlPath}.count\`, "x");
} catch {}
try {
  fs.writeFileSync(\`\${controlPath}.pid\`, String(process.pid));
} catch {}

let control = {};
try {
  control = JSON.parse(fs.readFileSync(controlPath, "utf-8"));
} catch {}

const mode = control.mode || "listen";

if (mode === "fail") {
  process.stderr.write(control.stderrText || "mock-ssh: connection refused\\n");
  process.exit(typeof control.exitCode === "number" ? control.exitCode : 255);
}

if (!localSock) {
  process.stderr.write("mock-ssh: could not parse -L forward from argv\\n");
  process.exit(1);
}

const pong = \`\${JSON.stringify({
  id: "",
  result: { type: "pong", version: "test", protocol: 19, capabilities: {} },
})}\\n\`;

const server = Bun.listen({
  unix: localSock,
  socket: {
    open() {
      if (mode === "listen-mute" && control.stderrOnConnect) {
        process.stderr.write(control.stderrOnConnect);
      }
    },
    data(socket) {
      if (mode !== "listen-mute") socket.write(pong);
    },
    close() {},
  },
});

if (control.stderrBanner) process.stderr.write(control.stderrBanner);

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    server.stop(true);
  } catch {}
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

if (mode === "die-after") {
  const ms = typeof control.dieAfterMs === "number" ? control.dieAfterMs : 300;
  setTimeout(() => shutdown(1), ms);
}
`;

interface Control {
  path: string;
  countPath: string;
  pidPath: string;
}

function writeControl(dir: string, id: string, control: Record<string, unknown>): Control {
  const controlPath = path.join(dir, `${id}.control.json`);
  fs.writeFileSync(controlPath, JSON.stringify(control));
  return {
    path: controlPath,
    countPath: `${controlPath}.count`,
    pidPath: `${controlPath}.pid`,
  };
}

function spawnCount(control: Control): number {
  try {
    return fs.readFileSync(control.countPath, "utf-8").length;
  } catch {
    return 0;
  }
}

function readPid(control: Control): number {
  return Number(fs.readFileSync(control.pidPath, "utf-8").trim());
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The fake reads its "host" argv slot as a control-file path instead
// of an ssh destination — TunnelManager never interprets `host`
// itself, just forwards it as the final ssh argv element, so this is
// invisible to the code under test.
function remoteTarget(
  name: string,
  controlPath: string,
  remoteSocket = "~/.config/herdr/herdr.sock",
): TargetConfig & { kind: "remote" } {
  return { name, kind: "remote", host: controlPath, remoteSocket };
}

async function rejection(promise: Promise<unknown>): Promise<TunnelError> {
  let err: unknown;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(TunnelError);
  return err as TunnelError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

describe("TunnelManager", () => {
  let tmpDir: string;
  let runDir: string;
  let sshBin: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "herddeck-tunnel-test-"));
    runDir = path.join(tmpDir, "run");
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    sshBin = path.join(tmpDir, "mock-ssh");
    fs.writeFileSync(sshBin, MOCK_SSH_SOURCE);
    fs.chmodSync(sshBin, 0o755);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves with the local socket path once the socket appears and answers a ping", async () => {
    const control = writeControl(tmpDir, "t1", { mode: "listen" });
    const mgr = new TunnelManager(runDir, { sshBin, pollIntervalMs: 20, pollTimeoutMs: 2000 });

    const sock = await mgr.localSocketFor(remoteTarget("workbox", control.path));

    expect(sock).toBe(path.join(runDir, "workbox.sock"));
    expect(fs.existsSync(sock)).toBe(true);
    expect(fs.statSync(sock).isSocket()).toBe(true);

    mgr.stop();
  });

  test("unlinks a stale socket file before establishing", async () => {
    const control = writeControl(tmpDir, "t2", { mode: "listen" });
    const stalePath = path.join(runDir, "workbox.sock");
    fs.writeFileSync(stalePath, "leftover, not a real socket");
    expect(fs.statSync(stalePath).isSocket()).toBe(false);

    const mgr = new TunnelManager(runDir, { sshBin, pollIntervalMs: 20, pollTimeoutMs: 2000 });
    const sock = await mgr.localSocketFor(remoteTarget("workbox", control.path));

    expect(sock).toBe(stalePath);
    expect(fs.statSync(stalePath).isSocket()).toBe(true);

    mgr.stop();
  });

  test("rejects non-transient when ssh exits with 'Permission denied'", async () => {
    const control = writeControl(tmpDir, "t3", {
      mode: "fail",
      exitCode: 255,
      stderrText: "Permission denied (publickey).\n",
    });
    const mgr = new TunnelManager(runDir, { sshBin, pollIntervalMs: 20, pollTimeoutMs: 2000 });

    const err = await rejection(mgr.localSocketFor(remoteTarget("workbox", control.path)));
    expect(err.message).toMatch(/Permission denied \(publickey\)/);
    expect(err.transient).toBe(false);

    mgr.stop();
  });

  test("rejects transient when ssh exits with 'Connection refused'", async () => {
    const control = writeControl(tmpDir, "t3b", {
      mode: "fail",
      exitCode: 255,
      stderrText: "ssh: connect to host workbox port 22: Connection refused\n",
    });
    const mgr = new TunnelManager(runDir, { sshBin, pollIntervalMs: 20, pollTimeoutMs: 2000 });

    const err = await rejection(mgr.localSocketFor(remoteTarget("workbox", control.path)));
    expect(err.message).toMatch(/Connection refused/);
    expect(err.transient).toBe(true);

    mgr.stop();
  });

  // R2: the socket file existing is NOT "established" — ssh binds
  // locally before any channel reaches the remote. A bound socket
  // with nothing answering behind it must fail the establish (probe),
  // classified transient, with ssh's async stderr line in the message.
  test("probe: bound socket with a dead far side fails transient with the stderr tail", async () => {
    const control = writeControl(tmpDir, "t6", {
      mode: "listen-mute",
      stderrOnConnect:
        "connect to /home/nick/.config/herdr/herdr.sock port 0 failed: Connection refused\n",
    });
    const mgr = new TunnelManager(runDir, {
      sshBin,
      pollIntervalMs: 20,
      pollTimeoutMs: 2000,
      probeTimeoutMs: 300,
    });

    const err = await rejection(mgr.localSocketFor(remoteTarget("workbox", control.path)));
    expect(err.transient).toBe(true);
    expect(err.message).toMatch(/ping probe through tunnel socket failed/);
    expect(err.message).toMatch(/connect to .* port 0 failed: Connection refused/);

    // The ssh that failed its probe must not linger.
    const pid = readPid(control);
    await waitFor(() => !isProcessAlive(pid), 2000);

    mgr.stop();
  });

  test("stderrTail exposes drained ssh stderr while the tunnel is up", async () => {
    const control = writeControl(tmpDir, "t7", {
      mode: "listen",
      stderrBanner: "debug1: Connecting to workbox port 22\n",
    });
    const mgr = new TunnelManager(runDir, { sshBin, pollIntervalMs: 20, pollTimeoutMs: 2000 });

    await mgr.localSocketFor(remoteTarget("workbox", control.path));
    await waitFor(() => mgr.stderrTail("workbox").length > 0, 2000);
    expect(mgr.stderrTail("workbox")).toContain("debug1: Connecting to workbox port 22");
    expect(mgr.stderrTail("unknown-target")).toEqual([]);

    mgr.stop();
  });

  test("retries with backoff after an established tunnel drops, notifying onStateChange", async () => {
    const control = writeControl(tmpDir, "t4", { mode: "die-after", dieAfterMs: 250 });
    const mgr = new TunnelManager(runDir, {
      sshBin,
      pollIntervalMs: 20,
      pollTimeoutMs: 2000,
      retryBaseMs: 100,
      retryMaxMs: 500,
    });
    const states: Array<[string, "up" | "down"]> = [];
    mgr.onStateChange((target, state) => states.push([target, state]));

    const target = remoteTarget("workbox", control.path);
    const sock = await mgr.localSocketFor(target);
    expect(fs.statSync(sock).isSocket()).toBe(true);
    expect(spawnCount(control)).toBe(1);

    // die-after (~250ms) fires -> ssh exits -> "down" notified ->
    // backoff (100ms) -> respawn -> socket reappears + probe pongs ->
    // "up" notified. The first localSocketFor() call is not
    // re-resolved for this; only onStateChange + the spawn counter
    // observe it.
    await waitFor(() => states.some(([, s]) => s === "down"), 3000);
    expect(states).toContainEqual([target.name, "down"]);

    await waitFor(() => spawnCount(control) >= 2, 3000);

    await waitFor(() => states.some(([, s]) => s === "up"), 3000);
    expect(states).toContainEqual([target.name, "up"]);

    mgr.stop();
  }, 10_000);

  test("stop() terminates ssh children and removes their sockets", async () => {
    const control = writeControl(tmpDir, "t5", { mode: "listen" });
    const mgr = new TunnelManager(runDir, { sshBin, pollIntervalMs: 20, pollTimeoutMs: 2000 });

    const sock = await mgr.localSocketFor(remoteTarget("workbox", control.path));
    const pid = readPid(control);
    expect(isProcessAlive(pid)).toBe(true);

    mgr.stop();

    expect(fs.existsSync(sock)).toBe(false);
    await waitFor(() => !isProcessAlive(pid), 2000);
    expect(isProcessAlive(pid)).toBe(false);
  });

  test("multiple targets get independent sockets named after them", async () => {
    const controlA = writeControl(tmpDir, "a", { mode: "listen" });
    const controlB = writeControl(tmpDir, "b", { mode: "listen" });
    const mgr = new TunnelManager(runDir, { sshBin, pollIntervalMs: 20, pollTimeoutMs: 2000 });

    const [sockA, sockB] = await Promise.all([
      mgr.localSocketFor(remoteTarget("alpha", controlA.path)),
      mgr.localSocketFor(remoteTarget("beta", controlB.path)),
    ]);

    expect(sockA).toBe(path.join(runDir, "alpha.sock"));
    expect(sockB).toBe(path.join(runDir, "beta.sock"));
    expect(fs.statSync(sockA).isSocket()).toBe(true);
    expect(fs.statSync(sockB).isSocket()).toBe(true);

    mgr.stop();
    expect(fs.existsSync(sockA)).toBe(false);
    expect(fs.existsSync(sockB)).toBe(false);
  });
});
