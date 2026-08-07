// Plugin-facing WebSocket server. One Bun.serve on 127.0.0.1 serving
// GET /health and WS upgrade on /ws. Commands arrive as WsCommand
// JSON frames; state flows out as WsEvent frames, broadcast to every
// connected plugin instance.

import type { ServerWebSocket } from "bun";
import { answerKeys } from "./answerMap";
import { HerdrApiError } from "./herdr/client";
import type { SessionRegistry } from "./registry";
import type { AgentSnapshot, TargetSnapshot, WsCommand, WsEvent } from "./wire";

export interface ServerDeps {
  registry: SessionRegistry;
  version: string;
  /** Foreground the terminal app (local targets only). */
  focusTerminal: () => Promise<void>;
  wispr: { start: () => void; stop: () => void };
}

export class DeckServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private sockets = new Set<ServerWebSocket<unknown>>();
  private lastAgents: AgentSnapshot[] = [];
  private lastTargets: TargetSnapshot[] = [];

  constructor(private deps: ServerDeps) {}

  start(port: number): void {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: (req, server) => {
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return Response.json({
            ok: true,
            version: this.deps.version,
            targets: this.lastTargets,
            agents: this.lastAgents.length,
            plugins: this.sockets.size,
          });
        }
        if (url.pathname === "/ws" && server.upgrade(req, { data: undefined }))
          return undefined as unknown as Response;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open: (ws) => {
          this.sockets.add(ws);
          this.send(ws, { type: "daemon:ready", version: this.deps.version });
          this.send(ws, { type: "targets:update", targets: this.lastTargets });
          this.send(ws, { type: "agents:update", agents: this.lastAgents });
        },
        close: (ws) => {
          this.sockets.delete(ws);
        },
        message: (_ws, message) => {
          void this.handleCommand(String(message));
        },
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  broadcast(event: WsEvent): void {
    if (event.type === "agents:update") this.lastAgents = event.agents;
    if (event.type === "targets:update") this.lastTargets = event.targets;
    const frame = JSON.stringify(event);
    for (const ws of this.sockets) ws.send(frame);
  }

  private send(ws: ServerWebSocket<unknown>, event: WsEvent): void {
    ws.send(JSON.stringify(event));
  }

  private async handleCommand(raw: string): Promise<void> {
    let cmd: WsCommand;
    try {
      cmd = JSON.parse(raw) as WsCommand;
    } catch {
      console.error(`ws: unparseable command: ${raw.slice(0, 200)}`);
      return;
    }
    try {
      await this.dispatch(cmd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`ws-cmd ${cmd.type} failed: ${msg}`);
    }
  }

  private async dispatch(cmd: WsCommand): Promise<void> {
    const { registry } = this.deps;
    switch (cmd.type) {
      case "agent:focus": {
        const monitor = registry.monitorFor(cmd.target);
        if (!monitor) return;
        await monitor.call("agent.focus", { target: cmd.paneId });
        const target = registry.targetSnapshots().find((t) => t.name === cmd.target);
        if (target?.kind === "local") await this.deps.focusTerminal();
        return;
      }
      case "agent:answer": {
        const monitor = registry.monitorFor(cmd.target);
        if (!monitor) return;
        const agent = registry.agentFor(cmd.target, cmd.paneId);
        const keys = answerKeys(agent?.agentKind ?? null, cmd.kind);
        try {
          await monitor.call("agent.send_keys", { target: cmd.paneId, keys });
        } catch (err) {
          // Injected/unready agents reject the agent surface; the pane
          // surface types the same bytes (verified in Phase 0).
          if (err instanceof HerdrApiError && err.code === "agent_not_ready") {
            await monitor.call("pane.send_keys", { pane_id: cmd.paneId, keys });
          } else {
            throw err;
          }
        }
        return;
      }
      case "agent:keys": {
        const monitor = registry.monitorFor(cmd.target);
        if (!monitor) return;
        await monitor.call("pane.send_keys", { pane_id: cmd.paneId, keys: cmd.keys });
        return;
      }
      case "worktree:create": {
        const monitor = registry.monitorFor(cmd.target);
        if (!monitor) return;
        await monitor.call("worktree.create", {
          workspace_id: cmd.workspaceId ?? null,
          focus: true,
        });
        return;
      }
      case "prompt:canned": {
        const monitor = registry.monitorFor(cmd.target);
        if (!monitor) return;
        await monitor.call("agent.prompt", { target: cmd.paneId, text: cmd.text });
        return;
      }
      case "wispr-flow:start":
        this.deps.wispr.start();
        return;
      case "wispr-flow:stop":
        this.deps.wispr.stop();
        return;
    }
  }
}
