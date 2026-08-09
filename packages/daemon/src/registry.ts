// SessionRegistry: one TargetMonitor per configured target, merged
// into the plugin-facing AgentSnapshot / TargetSnapshot views.
//
// Remote targets get their socket path from a TunnelProvider (Phase 3
// TunnelManager implements it); until a tunnel reports ready, the
// target shows as offline. The registry never spawns herdr.
//
// First-attempt tunnel failures are classified (R1): transient ones
// (network down at boot — launchd starts the daemon before Wi-Fi/VPN
// is up) are retried here on capped jittered backoff (15s -> 10min) by
// re-calling localSocketFor(); non-transient ones (auth/config) stay
// permanently offline. The classification is surfaced to the plugin
// via TargetSnapshot.detail ("retrying" | "auth" | null).

import type { HerdDeckConfig, TargetConfig } from "./config";
import { TargetMonitor, type TargetState } from "./herdr/monitor";
import { logDiag } from "./log";
import type { CachedAgent } from "./stateCache";
import { TunnelError } from "./tunnel";
import type { AgentSnapshot, SlotStatus, TargetSnapshot } from "./wire";

export interface TunnelProvider {
  /** Resolve the local socket path for a remote target, establishing
   * the tunnel if needed. Rejects when the tunnel cannot come up —
   * ideally with a TunnelError so the failure can be classified. */
  localSocketFor(target: TargetConfig & { kind: "remote" }): Promise<string>;
  stop(): void;
}

export interface RegistryEvents {
  targetsChanged(targets: TargetSnapshot[]): void;
  agentsChanged(agents: AgentSnapshot[]): void;
}

export interface RegistryOptions {
  /** First-attempt tunnel retry backoff floor (ms). Default 15_000. */
  tunnelRetryBaseMs?: number;
  /** First-attempt tunnel retry backoff ceiling (ms). Default 600_000. */
  tunnelRetryMaxMs?: number;
  /** Where failure diagnostics go; tests inject a sink (see
   * TunnelManagerOptions.log for why). Defaults to console.error. */
  log?: (message: string) => void;
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
  /** Tunnel failure classification, surfaced on TargetSnapshot. */
  detail: "auth" | "retrying" | null;
  retryBackoffMs: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** The loud console.error fires once per target, not once per retry. */
  failureLogged: boolean;
}

export class SessionRegistry {
  private targets = new Map<string, TargetRuntime>();
  private readonly log: (message: string) => void;
  private stopped = false;
  private readonly tunnelRetryBaseMs: number;
  private readonly tunnelRetryMaxMs: number;

  constructor(
    private config: HerdDeckConfig,
    private events: RegistryEvents,
    private tunnels?: TunnelProvider,
    opts: RegistryOptions = {},
  ) {
    this.tunnelRetryBaseMs = opts.tunnelRetryBaseMs ?? 15_000;
    this.tunnelRetryMaxMs = opts.tunnelRetryMaxMs ?? 600_000;
    this.log = opts.log ?? logDiag;
  }

  start(): void {
    for (const t of this.config.targets) {
      const rt: TargetRuntime = {
        config: t,
        monitor: null,
        state: "connecting",
        protocol: null,
        detail: null,
        retryBackoffMs: this.tunnelRetryBaseMs,
        retryTimer: null,
        failureLogged: false,
      };
      this.targets.set(t.name, rt);
      if (t.kind === "local") {
        this.attachMonitor(rt, t.socket);
      } else if (this.tunnels) {
        this.tryTunnel(rt, t);
      } else {
        rt.state = "offline";
      }
    }
    this.emitTargets();
  }

  private tryTunnel(rt: TargetRuntime, t: TargetConfig & { kind: "remote" }): void {
    if (!this.tunnels) return;
    this.tunnels
      .localSocketFor(t)
      .then((sock) => {
        if (this.stopped) return;
        rt.detail = null;
        this.attachMonitor(rt, sock);
        this.emitTargets();
      })
      .catch((err: unknown) => this.onTunnelFailure(rt, t, err));
  }

  private onTunnelFailure(
    rt: TargetRuntime,
    t: TargetConfig & { kind: "remote" },
    err: unknown,
  ): void {
    if (this.stopped) return;
    // Unclassified errors are treated as permanent: auto-retrying an
    // unknown failure mode forever is worse than showing it loudly.
    const transient = err instanceof TunnelError && err.transient;
    const message = err instanceof Error ? err.message : String(err);
    if (!rt.failureLogged) {
      rt.failureLogged = true;
      this.log(
        `target ${t.name}: tunnel failed: ${message}${transient ? " (will retry)" : " (not retrying — fix config/auth and restart)"}`,
      );
    }
    rt.state = "offline";
    rt.detail = transient ? "retrying" : "auth";
    this.emitTargets();
    if (transient) this.scheduleTunnelRetry(rt, t);
  }

  private scheduleTunnelRetry(rt: TargetRuntime, t: TargetConfig & { kind: "remote" }): void {
    if (this.stopped || rt.retryTimer) return;
    const jitter = 0.5 + Math.random(); // 0.5x–1.5x
    const delay = Math.min(rt.retryBackoffMs * jitter, this.tunnelRetryMaxMs);
    rt.retryBackoffMs = Math.min(rt.retryBackoffMs * 2, this.tunnelRetryMaxMs);
    rt.retryTimer = setTimeout(() => {
      rt.retryTimer = null;
      this.tryTunnel(rt, t);
    }, delay);
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
    this.stopped = true;
    for (const rt of this.targets.values()) {
      if (rt.retryTimer) {
        clearTimeout(rt.retryTimer);
        rt.retryTimer = null;
      }
      rt.monitor?.stop();
    }
    this.tunnels?.stop();
  }

  /** Whether agent:focus on this target should also foreground the
   * terminal app (config `focus_terminal`, default true). Unknown
   * targets: false — nothing to bring forward. */
  focusTerminalFor(target: string): boolean {
    return this.targets.get(target)?.config.focusTerminal ?? false;
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
      detail: rt.detail,
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
          tabLabel: a.tabLabel,
          ctxPct: Number.isFinite(ctxPct) ? ctxPct : null,
          focused: a.focused,
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
