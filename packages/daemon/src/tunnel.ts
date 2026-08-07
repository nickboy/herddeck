// TunnelManager: lazy `ssh -N -L` tunnels for remote targets. Forwarded
// sockets live at `<runDir>/<target-name>.sock` (caller guarantees
// runDir is 0700 — see paths.ensureRunDir). A leftover socket file
// makes ssh's `-L` bind fail, so every establish attempt unlinks the
// path first.
//
// Two failure regimes, per docs/plans/2026-08-06-master-plan.md Phase 3:
//   - First connect fails (bad host, bad remote_socket, auth denied):
//     localSocketFor() rejects and nothing is retried automatically —
//     that's almost always a config problem for the caller
//     (SessionRegistry) to surface, not something to paper over with a
//     retry loop.
//   - Tunnel drops *after* being established (network blip, remote
//     reboot): the "keepalive" case, retried in the background with
//     capped exponential backoff (2s -> 60s). onStateChange() is how
//     the registry/monitor layer learns about drops and recoveries;
//     the original localSocketFor() promise is never re-resolved —
//     only the first successful establish resolves it, since the
//     socket path itself never changes across retries.
//
// No shell string interpolation anywhere: ssh always runs from an
// argv array. The full command (which embeds the local socket path)
// is only ever logged on a failed establish attempt, never on success.

import fs from "node:fs";
import path from "node:path";
import type { TargetConfig } from "./config";
import type { TunnelProvider } from "./registry";

export type TunnelState = "up" | "down";
export type TunnelStateListener = (target: string, state: TunnelState) => void;

export interface TunnelManagerOptions {
  /** ssh binary/path to spawn. Defaults to "ssh"; tests inject a fake. */
  sshBin?: string;
  /** Poll interval while waiting for the local socket to appear (ms). Default 200. */
  pollIntervalMs?: number;
  /** Max time to wait for the local socket to appear before giving up (ms). Default 10_000. */
  pollTimeoutMs?: number;
  /** Keepalive retry backoff floor (ms). Default 2_000. */
  retryBaseMs?: number;
  /** Keepalive retry backoff ceiling (ms). Default 60_000. */
  retryMaxMs?: number;
}

type RemoteTargetConfig = TargetConfig & { kind: "remote" };
type SshProcess = Bun.Subprocess<"ignore", "ignore", "pipe">;
type SpawnResult = { ok: true } | { ok: false; message: string };

interface TunnelHandle {
  target: RemoteTargetConfig;
  socketPath: string;
  proc: SshProcess | null;
  /** True once this tunnel has come up at least once — governs the
   * localSocketFor() fast path (repeat calls just return the path;
   * the retry loop owns getting it back up). */
  everEstablished: boolean;
  /** True while the tunnel is currently believed to be up. */
  established: boolean;
  stopped: boolean;
  backoffMs: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** In-flight spawn attempt, so concurrent localSocketFor() calls for
   * the same target before the first establish join one attempt
   * instead of racing two ssh processes for the same socket path. */
  pending: Promise<SpawnResult> | null;
}

export class TunnelManager implements TunnelProvider {
  private readonly handles = new Map<string, TunnelHandle>();
  private readonly listeners = new Set<TunnelStateListener>();
  private readonly sshBin: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(
    private readonly runDir: string,
    opts: TunnelManagerOptions = {},
  ) {
    this.sshBin = opts.sshBin ?? "ssh";
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 10_000;
    this.retryBaseMs = opts.retryBaseMs ?? 2_000;
    this.retryMaxMs = opts.retryMaxMs ?? 60_000;
  }

  /** Registry/monitor layer subscribes to reflect tunnel drops + recoveries. */
  onStateChange(cb: TunnelStateListener): void {
    this.listeners.add(cb);
  }

  localSocketFor(target: RemoteTargetConfig): Promise<string> {
    const existing = this.handles.get(target.name);
    if (existing) {
      if (existing.everEstablished) return Promise.resolve(existing.socketPath);
      if (existing.pending)
        return existing.pending.then((r) => this.finishFirstAttempt(existing, r));
    }

    const socketPath = path.join(this.runDir, `${target.name}.sock`);
    const handle: TunnelHandle = existing ?? {
      target,
      socketPath,
      proc: null,
      everEstablished: false,
      established: false,
      stopped: false,
      backoffMs: this.retryBaseMs,
      retryTimer: null,
      pending: null,
    };
    this.handles.set(target.name, handle);

    const attempt = this.spawnAndWaitForSocket(handle);
    handle.pending = attempt;
    return attempt
      .then((result) => this.finishFirstAttempt(handle, result))
      .finally(() => {
        handle.pending = null;
      });
  }

  private finishFirstAttempt(handle: TunnelHandle, result: SpawnResult): string {
    if (!result.ok) {
      this.handles.delete(handle.target.name);
      throw new Error(`tunnel ${handle.target.name}: ${result.message}`);
    }
    handle.established = true;
    handle.everEstablished = true;
    handle.backoffMs = this.retryBaseMs;
    this.watchForExit(handle);
    return handle.socketPath;
  }

  stop(): void {
    for (const handle of this.handles.values()) {
      handle.stopped = true;
      if (handle.retryTimer) {
        clearTimeout(handle.retryTimer);
        handle.retryTimer = null;
      }
      handle.proc?.kill("SIGTERM");
      handle.proc = null;
      fs.rmSync(handle.socketPath, { force: true });
    }
    this.handles.clear();
  }

  // --- internals ---

  private buildArgs(handle: TunnelHandle): string[] {
    return [
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-L",
      `${handle.socketPath}:${handle.target.remoteSocket}`,
      handle.target.host,
    ];
  }

  private async spawnAndWaitForSocket(handle: TunnelHandle): Promise<SpawnResult> {
    fs.rmSync(handle.socketPath, { force: true });
    if (handle.stopped) return { ok: false, message: "stopped" };

    const args = this.buildArgs(handle);
    const proc = Bun.spawn<"ignore", "ignore", "pipe">([this.sshBin, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    handle.proc = proc;
    const stderrPromise = new Response(proc.stderr).text();

    let exited = false;
    let exitCode: number | null = null;
    proc.exited.then((code) => {
      exited = true;
      exitCode = code;
    });

    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      if (handle.stopped) return { ok: false, message: "stopped" };
      if (fs.existsSync(handle.socketPath)) return { ok: true };
      if (exited) {
        const stderrText = (await stderrPromise).trim();
        if (handle.proc === proc) handle.proc = null;
        const message = `ssh exited (code ${exitCode}) before tunnel established${
          stderrText ? `: ${stderrText}` : ""
        }`;
        this.logFailure(handle, args, message);
        return { ok: false, message };
      }
      await sleep(this.pollIntervalMs);
    }

    proc.kill("SIGTERM");
    if (handle.proc === proc) handle.proc = null;
    const message = `timed out waiting for tunnel socket after ${this.pollTimeoutMs}ms`;
    this.logFailure(handle, args, message);
    return { ok: false, message };
  }

  private logFailure(handle: TunnelHandle, args: string[], message: string): void {
    console.error(
      `herddeck: tunnel ${handle.target.name} failed to establish (${this.sshBin} ${args.join(" ")}): ${message}`,
    );
  }

  private watchForExit(handle: TunnelHandle): void {
    const proc = handle.proc;
    if (!proc) return;
    proc.exited.then(() => {
      if (handle.stopped || handle.proc !== proc) return;
      handle.established = false;
      handle.proc = null;
      this.notify(handle.target.name, "down");
      this.scheduleRetry(handle);
    });
  }

  private scheduleRetry(handle: TunnelHandle): void {
    if (handle.stopped) return;
    const delay = handle.backoffMs;
    handle.backoffMs = Math.min(handle.backoffMs * 2, this.retryMaxMs);
    handle.retryTimer = setTimeout(() => {
      handle.retryTimer = null;
      void this.retry(handle);
    }, delay);
  }

  private async retry(handle: TunnelHandle): Promise<void> {
    if (handle.stopped) return;
    const result = await this.spawnAndWaitForSocket(handle);
    if (handle.stopped) return;
    if (result.ok) {
      handle.established = true;
      handle.backoffMs = this.retryBaseMs;
      this.notify(handle.target.name, "up");
      this.watchForExit(handle);
    } else {
      this.scheduleRetry(handle);
    }
  }

  private notify(target: string, state: TunnelState): void {
    for (const cb of this.listeners) cb(target, state);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
