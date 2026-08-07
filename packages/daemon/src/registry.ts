// SessionRegistry: one TargetMonitor per configured target, merged
// into the plugin-facing AgentSnapshot / TargetSnapshot views.
//
// Remote targets get their socket path from a TunnelProvider (Phase 3
// TunnelManager implements it); until a tunnel reports ready, the
// target shows as offline. The registry never spawns herdr.

import type { CachedAgent } from "./stateCache";
import type { HerdDeckConfig, TargetConfig } from "./config";
import { TargetMonitor, type TargetState } from "./herdr/monitor";
import type { AgentSnapshot, SlotStatus, TargetSnapshot } from "./wire";

export interface TunnelProvider {
  /** Resolve the local socket path for a remote target, establishing
   * the tunnel if needed. Rejects when the tunnel cannot come up. */
  localSocketFor(target: TargetConfig & { kind: "remote" }): Promise<string>;
  stop(): void;
}

export interface RegistryEvents {
  targetsChanged(targets: TargetSnapshot[]): void;
  agentsChanged(agents: AgentSnapshot[]): void;
}

const STATUS_ORDER: Record<SlotStatus, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
  offline: 5,
};

interface TargetRuntime {
  config: TargetConfig;
  monitor: TargetMonitor | null;
  state: TargetState;
  protocol: number | null;
}

export class SessionRegistry {
  private targets = new Map<string, TargetRuntime>();

  constructor(
    private config: HerdDeckConfig,
    private events: RegistryEvents,
    private tunnels?: TunnelProvider,
  ) {}

  start(): void {
    for (const t of this.config.targets) {
      const rt: TargetRuntime = { config: t, monitor: null, state: "connecting", protocol: null };
      this.targets.set(t.name, rt);
      if (t.kind === "local") {
        this.attachMonitor(rt, t.socket);
      } else if (this.tunnels) {
        this.tunnels
          .localSocketFor(t)
          .then((sock) => this.attachMonitor(rt, sock))
          .catch((err) => {
            console.error(`target ${t.name}: tunnel failed: ${err.message}`);
            rt.state = "offline";
            this.emitTargets();
          });
      } else {
        rt.state = "offline";
      }
    }
    this.emitTargets();
  }

  private attachMonitor(rt: TargetRuntime, socketPath: string): void {
    rt.monitor = new TargetMonitor(rt.config.name, socketPath, {
      status: (state, protocol) => {
        rt.state = state;
        rt.protocol = protocol;
        this.emitTargets();
        // Offline flips every agent of this target to "offline" slots.
        this.emitAgents();
      },
      agentsChanged: () => this.emitAgents(),
    });
    rt.monitor.start();
  }

  stop(): void {
    for (const rt of this.targets.values()) rt.monitor?.stop();
    this.tunnels?.stop();
  }

  monitorFor(target: string): TargetMonitor | null {
    return this.targets.get(target)?.monitor ?? null;
  }

  agentFor(target: string, paneId: string): CachedAgent | null {
    const monitor = this.monitorFor(target);
    return monitor?.cache.agents().find((a) => a.paneId === paneId) ?? null;
  }

  targetSnapshots(): TargetSnapshot[] {
    return [...this.targets.values()].map((rt) => ({
      name: rt.config.name,
      kind: rt.config.kind,
      state: rt.state,
      protocol: rt.protocol,
    }));
  }

  agentSnapshots(): AgentSnapshot[] {
    const out: AgentSnapshot[] = [];
    for (const rt of this.targets.values()) {
      if (!rt.monitor) continue;
      const offline = rt.state === "offline" || rt.state === "connecting";
      for (const a of rt.monitor.cache.agents()) {
        const ctxRaw = a.tokens.ctx_pct;
        const ctxPct = ctxRaw !== undefined ? Number.parseInt(ctxRaw, 10) : Number.NaN;
        out.push({
          target: rt.config.name,
          paneId: a.paneId,
          name: a.name,
          agentKind: a.agentKind,
          status: offline ? "offline" : a.status,
          workspaceLabel: rt.monitor.cache.workspaceLabel(a.workspaceId),
          cwd: a.cwd,
          title: a.title,
          ctxPct: Number.isFinite(ctxPct) ? ctxPct : null,
          stateChangeSeq: a.stateChangeSeq,
        });
      }
    }
    out.sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        a.target.localeCompare(b.target) ||
        a.paneId.localeCompare(b.paneId),
    );
    return out;
  }

  private emitTargets(): void {
    this.events.targetsChanged(this.targetSnapshots());
  }

  private emitAgents(): void {
    this.events.agentsChanged(this.agentSnapshots());
  }
}
