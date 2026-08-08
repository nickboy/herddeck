// Tier-1 fake-remote integration (review matrix T1/T2/T4/T5/T9-lite):
// exercises the REAL remote path — sshd streamlocal forward, BatchMode
// auth, tunnel establish/probe, monitor-over-tunnel — with localhost as
// the far side. Requires: macOS Remote Login enabled (sshd on :22),
// `ssh -o BatchMode=yes localhost true` succeeding, and the
// herddeck-test session server running. Guarded: set HERDDECK_FAKE_REMOTE=1.
//
// Run: HERDDECK_FAKE_REMOTE=1 bun packages/daemon/test/integration/live-fake-remote.ts

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TargetMonitor } from "../../src/herdr/monitor.ts";
import { TunnelManager } from "../../src/tunnel.ts";

if (process.env.HERDDECK_FAKE_REMOTE !== "1") {
  console.log("SKIP: set HERDDECK_FAKE_REMOTE=1 (needs sshd on localhost)");
  process.exit(0);
}

const REMOTE_SOCK = `${process.env.HOME}/.config/herdr/sessions/herddeck-test/herdr.sock`;
const runDir = mkdtempSync(join(tmpdir(), "herddeck-fake-remote-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

const tunnels = new TunnelManager(runDir);
const target = {
  name: "fakebox",
  kind: "remote" as const,
  host: "localhost",
  remoteSocket: REMOTE_SOCK,
};

// T1: lazy establish (includes the R2 ping-probe through the forward).
const sock = await tunnels.localSocketFor(target).catch((e) => fail(`T1 establish: ${e.message}`));
console.log(`T1 PASS: tunnel up at ${sock}`);

// Monitor over the tunnel: full protocol through a real streamlocal forward.
const states: string[] = [];
const monitor = new TargetMonitor(
  "fakebox",
  sock as string,
  {
    status: (s) => {
      states.push(s);
      console.log(`[status] ${s}`);
    },
    agentsChanged: () => {},
  },
  { backoffMs: [300, 2000] },
);
monitor.start();
await sleep(1500);
if (!states.includes("online")) fail("monitor never online over tunnel");
console.log("T9-lite PASS: monitor online through the forward");

// T2: kill the ssh process → down event, then auto-recovery.
let sawDown = false;
let sawUp = false;
tunnels.onStateChange((_t, s) => {
  if (s === "down") sawDown = true;
  if (s === "up") sawUp = true;
});
execSync("pkill -f 'ssh -N .*fake' || pkill -f 'ssh -N'", { stdio: "ignore" });
await sleep(4000);
if (!sawDown) fail("T2: no down event after killing ssh");
if (!sawUp) fail("T2: no recovery within backoff window");
console.log("T2 PASS: down + auto-recovery");

monitor.stop();
tunnels.stop();
rmSync(runDir, { recursive: true, force: true });
console.log("PASS: T1, T2, T9-lite (see review doc for T4/T5/T7 manual steps)");
process.exit(0);
