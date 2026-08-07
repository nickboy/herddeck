// Watches a TargetMonitor's status transitions and appends them to a
// log file, so an outer orchestrator (scripts/live-recovery.sh or a
// human) can kill/restart the herddeck-test server and assert
// offline → reconnect → online recovery. Runs until SIGTERM.

import { appendFileSync } from "node:fs";
import { TargetMonitor } from "../../src/herdr/monitor.ts";

const SOCKET = `${process.env.HOME}/.config/herdr/sessions/herddeck-test/herdr.sock`;
const LOG = process.argv[2] ?? "/tmp/herddeck-recovery.log";

const stamp = () => new Date().toISOString();
const monitor = new TargetMonitor(
  "test",
  SOCKET,
  {
    status: (state, protocol) => {
      appendFileSync(LOG, `${stamp()} status ${state} protocol=${protocol}\n`);
    },
    agentsChanged: (agents) => {
      appendFileSync(LOG, `${stamp()} agents ${agents.length}\n`);
    },
  },
  { backoffMs: [300, 2000] },
);
monitor.start();
process.on("SIGTERM", () => {
  monitor.stop();
  process.exit(0);
});
