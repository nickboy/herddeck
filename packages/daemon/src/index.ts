// Daemon entry: config → registry (+ tunnels) → WS server → plan
// poller, with graceful shutdown. Run directly (`bun src/index.ts`)
// or under launchd via `herddeck install`.

import { claudeAiFetcher } from "./claudeAiFetcher";
import { loadConfig } from "./config";
import { focusTerminalApp } from "./focus";
import { ensureRunDir } from "./paths";
import { PlanUsagePoller } from "./planUsagePoller";
import { SessionRegistry } from "./registry";
import { DeckServer } from "./server";
import { TunnelManager } from "./tunnel";
import { runTrigger } from "./wisprFlowTrigger";

const VERSION = "0.1.0";
const PLAN_POLL_INTERVAL_MS = 60_000;

const config = loadConfig();
const hasRemote = config.targets.some((t) => t.kind === "remote");
const tunnels = hasRemote ? new TunnelManager(ensureRunDir()) : undefined;

let server: DeckServer;

const registry = new SessionRegistry(
  config,
  {
    targetsChanged: (targets) => server?.broadcast({ type: "targets:update", targets }),
    agentsChanged: (agents) => server?.broadcast({ type: "agents:update", agents }),
  },
  tunnels,
);

server = new DeckServer({
  registry,
  version: VERSION,
  focusTerminal: () => focusTerminalApp(config.terminalApp),
  wispr: {
    start: () => runTrigger("start"),
    stop: () => runTrigger("stop"),
  },
});

server.start(config.port);
registry.start();
console.log(
  `herddeck daemon ${VERSION} on 127.0.0.1:${config.port} — targets: ${config.targets
    .map((t) => `${t.name}(${t.kind})`)
    .join(", ")}`,
);

let poller: PlanUsagePoller | null = null;
if (config.planUsageEnabled) {
  poller = new PlanUsagePoller({ fetcher: claudeAiFetcher, intervalMs: PLAN_POLL_INTERVAL_MS });
  poller.on("update", (snapshot) => server.broadcast({ type: "plan:update", snapshot }));
  poller.on("error", (reason) => server.broadcast({ type: "plan:error", reason: String(reason) }));
  poller.start();
}

function shutdown(): void {
  console.log("herddeck daemon shutting down");
  poller?.stop();
  registry.stop();
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
