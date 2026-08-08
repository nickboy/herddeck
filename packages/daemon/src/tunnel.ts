// TunnelManager: lazy `ssh -N -L` tunnels for remote targets. Forwarded
// sockets live at `<runDir>/<target-name>.sock` (caller guarantees
// runDir is 0700 — see paths.ensureRunDir). A leftover socket file
// makes ssh's `-L` bind fail, so every establish attempt unlinks the
// path first.
//
// "Established" means more than "the local socket file exists": ssh
// binds the local socket before any channel ever reaches the remote,
// so a bound socket with a dead far side would look healthy forever.
// Establish therefore ends with a ping probe THROUGH the socket (R2);
// only a pong makes the tunnel count as up. ssh reports far-side
// connect failures (`connect to <path> port 0 failed: ...`) on stderr
// asynchronously, so stderr is drained for the tunnel's whole lifetime
// into a per-target ring buffer (stderrTail()) and surfaced in probe
// failure messages.
//
// Two failure regimes, per docs/plans/2026-08-06-master-plan.md Phase 3:
//   - First connect fails: localSocketFor() rejects with a TunnelError
//     carrying a transient classification. Config/auth failures
//     (Permission denied, host key, bad config) are permanent —
//     transient: false. Network-ish failures (refused, timeout,
//     unreachable, DNS — ambiguous under VPN — poll timeout, probe
//     failure) are transient: true, and the CALLER (SessionRegistry,
//     R1) owns retrying them. TunnelManager never retries a first
//     attempt itself.
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
import { HerdrClient } from "./herdr/client";
import type { TunnelProvider } from "./registry";

export type TunnelState = "up" | "down";
export type TunnelStateListener = (target: string, state: TunnelState) => void;

/** Thrown by localSocketFor() when the first establish attempt fails.
 * `transient: true` means the failure looked network-shaped and the
 * caller should retry later; `transient: false` means config/auth —
 * retrying without human intervention is pointless. */
export class TunnelError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "TunnelError";
  }
}

export interface TunnelManagerOptions {
  /** Where failure diagnostics go. Defaults to console.error; tests
   * inject a sink so deliberately-failing cases don't print scary
   * (but expected) lines during `bun test` — which install.sh runs,
   * where they read as a broken install. */
  log?: (message: string) => void;
  /** ssh binary/path to spawn. Defaults to "ssh"; tests inject a fake. */
  sshBin?: string;
  /** Poll interval while waiting for the local socket to appear (ms). Default 200. */
  pollIntervalMs?: number;
  /** Max time to wait for the local socket to appear before giving up (ms). Default 10_000. */
  pollTimeoutMs?: number;
  /** Timeout for the post-bind ping probe through the socket (ms). Default 4_000. */
  probeTimeoutMs?: number;
  /** Keepalive retry backoff floor (ms). Default 2_000. */
  retryBaseMs?: number;
  /** Keepalive retry backoff ceiling (ms). Default 60_000. */
  retryMaxMs?: number;
}

type RemoteTargetConfig = TargetConfig & { kind: "remote" };
type SshProcess = Bun.Subprocess<"ignore", "ignore", "pipe">;
type SpawnResult = { ok: true } | { ok: false; message: string; transient: boolean };

/** Ring buffer capacity for drained ssh stderr lines, per target. */
const STDERR_TAIL_LINES = 40;

/** Definitive config/auth failures — retrying cannot help. Anything
 * else (Connection refused, Operation timed out, Network is
 * unreachable, Could not resolve hostname — DNS is ambiguous under a
 * down VPN, so it retries) defaults to transient. */
const NON_TRANSIENT_STDERR = [
  "Permission denied",
  "Host key verification failed",
  "Bad configuration",
  "Bad owner or permissions",
];

function classifyTransient(stderrText: string): boolean {
  return !NON_TRANSIENT_STDERR.some((needle) => stderrText.includes(needle));
}

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
  /** Last STDERR_TAIL_LINES lines of ssh stderr, across respawns. */
  stderrRing: string[];
}

export class TunnelManager implements TunnelProvider {
  private readonly handles = new Map<string, TunnelHandle>();
  private readonly listeners = new Set<TunnelStateListener>();
  private readonly sshBin: string;
  private readonly log: (message: string) => void;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(
    private readonly runDir: string,
    opts: TunnelManagerOptions = {},
  ) {
    this.sshBin = opts.sshBin ?? "ssh";
    this.log = opts.log ?? ((m) => console.error(m));
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 10_000;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 4_000;
    this.retryBaseMs = opts.retryBaseMs ?? 2_000;
    this.retryMaxMs = opts.retryMaxMs ?? 60_000;
  }

  /** Registry/monitor layer subscribes to reflect tunnel drops + recoveries. */
  onStateChange(cb: TunnelStateListener): void {
    this.listeners.add(cb);
  }

  /** Last ~40 lines of the target's ssh stderr, for diagnostics
   * (doctor, failure messages). Empty if the target has no live
   * handle — failed first attempts carry their tail in the
   * TunnelError message instead. */
  stderrTail(target: string): string[] {
    return [...(this.handles.get(target)?.stderrRing ?? [])];
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
      stderrRing: [],
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

  // On failure the handle is deleted, so a LATER localSocketFor() call
  // starts a fresh first attempt from scratch. That re-entry is owned
  // by the SessionRegistry retry loop (R1): it inspects
  // TunnelError.transient and re-calls localSocketFor() on capped
  // backoff for transient failures. TunnelManager's own backoff loop
  // (scheduleRetry) only ever runs AFTER a successful establish (R8c).
  private finishFirstAttempt(handle: TunnelHandle, result: SpawnResult): string {
    if (!result.ok) {
      this.handles.delete(handle.target.name);
      throw new TunnelError(`tunnel ${handle.target.name}: ${result.message}`, result.transient);
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
      // Own the connection lifecycle: with the user's ControlMaster
      // auto config the tunnel would otherwise mux onto (or become) a
      // shared master and its forward would die with that master's
      // ControlPersist timer (found live in Tier-1 testing).
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
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

  /** Drain the ssh process's stderr for its whole lifetime,
   * line-buffered, into both the handle's lifetime ring buffer and a
   * per-spawn tail (used for failure messages / classification, so
   * lines from a previous spawn can't bleed into this attempt's
   * verdict). Resolves when the stream closes (i.e. ssh exited). */
  private drainStderr(handle: TunnelHandle, proc: SshProcess, spawnTail: string[]): Promise<void> {
    const push = (raw: string) => {
      const line = raw.trimEnd();
      if (!line) return;
      handle.stderrRing.push(line);
      if (handle.stderrRing.length > STDERR_TAIL_LINES) handle.stderrRing.shift();
      spawnTail.push(line);
      if (spawnTail.length > STDERR_TAIL_LINES) spawnTail.shift();
    };
    return (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stderr) {
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          push(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      }
      buf += decoder.decode();
      push(buf);
    })().catch(() => {});
  }

  private async spawnAndWaitForSocket(handle: TunnelHandle): Promise<SpawnResult> {
    fs.rmSync(handle.socketPath, { force: true });
    if (handle.stopped) return { ok: false, message: "stopped", transient: true };

    const args = this.buildArgs(handle);
    const proc = Bun.spawn<"ignore", "ignore", "pipe">([this.sshBin, ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    handle.proc = proc;
    const spawnTail: string[] = [];
    const stderrDone = this.drainStderr(handle, proc, spawnTail);

    let exited = false;
    let exitCode: number | null = null;
    proc.exited.then((code) => {
      exited = true;
      exitCode = code;
    });

    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      if (handle.stopped) return { ok: false, message: "stopped", transient: true };
      if (fs.existsSync(handle.socketPath))
        return this.probeSocket(handle, proc, args, spawnTail, stderrDone);
      if (exited) {
        // Stream closed at exit; give the drain loop a beat to flush.
        await Promise.race([stderrDone, sleep(500)]);
        if (handle.proc === proc) handle.proc = null;
        const stderrText = spawnTail.join("\n");
        const message = `ssh exited (code ${exitCode}) before tunnel established${
          stderrText ? `: ${stderrText}` : ""
        }`;
        this.logFailure(handle, args, message);
        return { ok: false, message, transient: classifyTransient(stderrText) };
      }
      await sleep(this.pollIntervalMs);
    }

    proc.kill("SIGTERM");
    if (handle.proc === proc) handle.proc = null;
    const message = `timed out waiting for tunnel socket after ${this.pollTimeoutMs}ms`;
    this.logFailure(handle, args, message);
    return { ok: false, message, transient: true };
  }

  /** The socket file existing only proves ssh bound it locally — the
   * far side may be dead (remote herdr down, wrong remote_socket
   * path). One ping through the socket proves the whole path; on
   * failure the real cause is ssh's async
   * `connect to <path> port 0 failed: ...` stderr line, so the drained
   * tail is folded into the message. Probe failures are always
   * transient: the remote side coming up later is exactly the case the
   * registry retry loop exists for. */
  private async probeSocket(
    handle: TunnelHandle,
    proc: SshProcess,
    args: string[],
    spawnTail: string[],
    stderrDone: Promise<void>,
  ): Promise<SpawnResult> {
    try {
      await new HerdrClient(handle.socketPath).call("ping", {}, this.probeTimeoutMs);
    } catch (err) {
      proc.kill("SIGTERM");
      if (handle.proc === proc) handle.proc = null;
      await Promise.race([stderrDone, sleep(500)]);
      const stderrText = spawnTail.join("\n");
      const message = `ping probe through tunnel socket failed: ${
        err instanceof Error ? err.message : String(err)
      }${stderrText ? ` — ssh stderr: ${stderrText}` : ""}`;
      this.logFailure(handle, args, message);
      return { ok: false, message, transient: true };
    }
    if (handle.stopped) return { ok: false, message: "stopped", transient: true };
    return { ok: true };
  }

  private logFailure(handle: TunnelHandle, args: string[], message: string): void {
    this.log(
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
