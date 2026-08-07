#!/usr/bin/env bun
// herddeck — CLI for the HerdDeck daemon: status / doctor / install / uninstall.
//
// Big simplification vs ClaudeDeck (see docs/CONTRACTS.md, docs/plans/
// 2026-08-06-master-plan.md): no .app bundle, no codesigning, no
// Accessibility/TCC — herdr replaced all of that. The daemon runs as
// plain `bun packages/daemon/src/index.ts` under launchd.
//
// This package must NOT import packages/daemon internals (module
// boundary in docs/CONTRACTS.md). Anything the CLI needs from the
// daemon's world — the configured port, remote target names — is
// re-derived here with small, deliberately minimal readers instead of
// sharing daemon/src/config.ts's full TOML parser.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injection point for spawning subprocesses (herdr, launchctl). Tests
 * supply a fake so no real launchctl/herdr ever runs under `bun test`. */
export type ExecFn = (cmd: string, args: readonly string[]) => Promise<ExecResult>;

/** Deliberately narrower than `typeof fetch` — Bun's global `fetch`
 * carries extra static members (e.g. `preconnect`) that a plain test
 * fake has no reason to implement. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CliOptions {
  home: string;
  herddeckDir: string;
  configPath: string;
  launchAgentsDir: string;
  /** Repo root, used to locate packages/daemon/src/index.ts for the plist. */
  repoRoot: string;
  /** Absolute path to the bun executable running this process. */
  bunPath: string;
  uid: string;
  fetchImpl: FetchLike;
  exec: ExecFn;
}

const DEFAULT_PORT = 9137;

/** herdr wire protocol version this daemon targets (docs/CONTRACTS.md,
 * packages/protocol EXPECTED_PROTOCOL). Duplicated here rather than
 * importing @herddeck/protocol so the CLI stays a zero-dependency
 * standalone script. */
const EXPECTED_PROTOCOL = 19;

export const LAUNCHD_LABEL = "com.nickboy.herddeck.daemon";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultExec(): ExecFn {
  return async (cmd, args) => {
    try {
      const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      return { stdout, stderr, exitCode };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: "", stderr: msg, exitCode: 127 };
    }
  };
}

export function defaultCliOptions(): CliOptions {
  const home = homedir();
  const herddeckDir = join(home, ".herddeck");
  // Resolve repo root from this file's own location — packages/cli/src
  // is three levels below the repo root — so `herddeck install` finds
  // packages/daemon/src/index.ts regardless of cwd.
  const here = resolve(import.meta.dir ?? dirname(import.meta.path ?? "."));
  const repoRoot = resolve(here, "..", "..", "..");
  return {
    home,
    herddeckDir,
    configPath: join(herddeckDir, "config.toml"),
    launchAgentsDir: join(home, "Library", "LaunchAgents"),
    repoRoot,
    bunPath: process.execPath,
    uid: String(process.getuid?.() ?? 501),
    fetchImpl: fetch,
    exec: defaultExec(),
  };
}

// ---------------------------------------------------------------------------
// Minimal config readers (no daemon import — see module boundary note above)
// ---------------------------------------------------------------------------

/** Read `[daemon] port = N` from config.toml without a full TOML parser.
 * Missing file, missing key, or unparseable value all fall back to the
 * documented default (docs/CONTRACTS.md). */
export function readConfiguredPort(configPath: string): number {
  try {
    if (!existsSync(configPath)) return DEFAULT_PORT;
    const content = readFileSync(configPath, "utf8");
    const match = content.match(/port\s*=\s*(\d+)/);
    if (!match) return DEFAULT_PORT;
    const port = Number.parseInt(match[1] ?? "", 10);
    return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/** Names of `[[targets]]` entries with `kind = "remote"`. Used only for
 * doctor's per-target tunnel-socket check — a regex scan is enough; we
 * don't need daemon/src/config.ts's validation or home-expansion. */
export function readRemoteTargetNames(configPath: string): string[] {
  if (!existsSync(configPath)) return [];
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  const blocks = content.split(/\[\[targets\]\]/).slice(1);
  const names: string[] = [];
  for (const block of blocks) {
    // Bound each block at the next top-level table/array-of-tables
    // marker, in case a `[[targets]]` entry isn't the last thing in
    // the file.
    const endIdx = block.search(/\n\[/);
    const body = endIdx >= 0 ? block.slice(0, endIdx) : block;
    const nameMatch = body.match(/name\s*=\s*"([^"]+)"/);
    const kindMatch = body.match(/kind\s*=\s*"([^"]+)"/);
    if (nameMatch?.[1] && kindMatch?.[1] === "remote") {
      names.push(nameMatch[1]);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// launchd plist
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&apos;")
    .replaceAll('"', "&quot;");
}

export interface LaunchAgentPlistOptions {
  label?: string;
  /** Absolute path to the bun executable — ProgramArguments[0]. */
  bunPath: string;
  /** Absolute path to packages/daemon/src/index.ts — ProgramArguments[1]. */
  daemonEntry: string;
  logPath: string;
}

export function buildLaunchAgentPlist(opts: LaunchAgentPlistOptions): string {
  const label = opts.label ?? LAUNCHD_LABEL;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(opts.bunPath)}</string>
    <string>${escapeXml(opts.daemonEntry)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.logPath)}</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

export function writeLaunchAgentPlist(path: string, opts: LaunchAgentPlistOptions): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildLaunchAgentPlist(opts));
}

/** Guards `uninstall` against deleting a plist it didn't write. */
export function isLaunchAgentPlistOurs(path: string, label: string = LAUNCHD_LABEL): boolean {
  if (!existsSync(path)) return false;
  try {
    const content = readFileSync(path, "utf8");
    return content.includes(`<string>${label}</string>`);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// `herdr status` output parsing
// ---------------------------------------------------------------------------

export interface HerdrStatus {
  clientVersion: string | null;
  clientProtocol: number | null;
  serverRunning: boolean;
  serverVersion: string | null;
  serverProtocol: number | null;
  socket: string | null;
}

/** Parses the indented `section:\n  key: value` text `herdr status`
 * prints (verified live: see docs/plans/2026-08-06-master-plan.md). No
 * JSON output mode exists for this subcommand at the time of writing. */
export function parseHerdrStatus(output: string): HerdrStatus {
  const result: HerdrStatus = {
    clientVersion: null,
    clientProtocol: null,
    serverRunning: false,
    serverVersion: null,
    serverProtocol: null,
    socket: null,
  };
  let section: string | null = null;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    const sectionMatch = line.match(/^(\S+):\s*$/);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1];
      continue;
    }
    const kv = line.match(/^\s+(\S+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = (kv[2] ?? "").trim();
    if (section === "client") {
      if (key === "version") result.clientVersion = value;
      if (key === "protocol") result.clientProtocol = Number.parseInt(value, 10) || null;
    } else if (section === "server") {
      if (key === "status") result.serverRunning = value === "running";
      if (key === "version") result.serverVersion = value;
      if (key === "protocol") result.serverProtocol = Number.parseInt(value, 10) || null;
      if (key === "socket") result.socket = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorResult {
  name: string;
  status: DoctorStatus;
  detail: string;
  /** Shown only when status !== "ok". */
  fix?: string;
}

export async function checkHerdrBinary(
  exec: ExecFn,
): Promise<{ result: DoctorResult; herdrStatus: HerdrStatus | null }> {
  const res = await exec("herdr", ["status"]);
  // defaultExec() returns exitCode 127 with empty stdout when the
  // executable can't be spawned at all (Bun.spawn throws ENOENT-style).
  if (res.exitCode === 127 && !res.stdout.trim()) {
    return {
      result: {
        name: "herdr-binary",
        status: "fail",
        detail: "herdr not found on PATH",
        fix: "Install herdr and ensure it is on $PATH (see herdr docs).",
      },
      herdrStatus: null,
    };
  }
  const parsed = parseHerdrStatus(res.stdout);
  if (res.exitCode !== 0) {
    return {
      result: {
        name: "herdr-binary",
        status: "warn",
        detail: `herdr on PATH but \`herdr status\` exited ${res.exitCode}`,
        fix: "Run `herdr status` directly to see the error.",
      },
      herdrStatus: parsed,
    };
  }
  if (!parsed.serverRunning) {
    return {
      result: {
        name: "herdr-binary",
        status: "warn",
        detail: `herdr ${parsed.clientVersion ?? "?"} (protocol ${parsed.clientProtocol ?? "?"}) on PATH, server not running`,
        fix: "Start a local herdr session with `herdr` — until then this target shows offline (never auto-started by herddeck).",
      },
      herdrStatus: parsed,
    };
  }
  return {
    result: {
      name: "herdr-binary",
      status: "ok",
      detail: `herdr ${parsed.serverVersion ?? parsed.clientVersion ?? "?"} (protocol ${parsed.serverProtocol ?? parsed.clientProtocol ?? "?"}), server running`,
    },
    herdrStatus: parsed,
  };
}

export function checkHerdrSocket(socketPath: string): DoctorResult {
  if (existsSync(socketPath)) {
    return { name: "herdr-socket", status: "ok", detail: socketPath };
  }
  return {
    name: "herdr-socket",
    status: "warn",
    detail: `not found at ${socketPath}`,
    fix: "Expected if no local herdr session is running yet; the local target will show offline until one starts.",
  };
}

export interface DaemonHealthOpts {
  url: string;
  fetchImpl: FetchLike;
}

export async function checkDaemonHealth(opts: DaemonHealthOpts): Promise<DoctorResult> {
  try {
    const res = await opts.fetchImpl(opts.url);
    if (!res.ok) {
      return {
        name: "daemon-health",
        status: "fail",
        detail: `HTTP ${res.status} from ${opts.url}`,
        fix: "Check ~/.herddeck/daemon.log for startup errors.",
      };
    }
    let version: string | undefined;
    try {
      const body = (await res.json()) as { version?: string };
      version = body.version;
    } catch {
      // Non-JSON /health body — still counts as "responding".
    }
    return {
      name: "daemon-health",
      status: "ok",
      detail: `responding${version ? ` (v${version})` : ""}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "daemon-health",
      status: "fail",
      detail: msg,
      fix: "Start the daemon: `herddeck install`, or run it directly with `bun packages/daemon/src/index.ts`.",
    };
  }
}

/** Always at most "warn" — protocol drift degrades a target to a
 * warning state (docs/CONTRACTS.md), it never fails doctor outright. */
export function checkProtocolMatch(herdrStatus: HerdrStatus | null): DoctorResult {
  const protocol = herdrStatus?.serverProtocol ?? herdrStatus?.clientProtocol ?? null;
  if (protocol === null) {
    return {
      name: "protocol-match",
      status: "warn",
      detail: "herdr protocol unknown — could not run `herdr status` (informational)",
    };
  }
  if (protocol === EXPECTED_PROTOCOL) {
    return {
      name: "protocol-match",
      status: "ok",
      detail: `herdr protocol ${protocol} matches expected ${EXPECTED_PROTOCOL} (informational)`,
    };
  }
  return {
    name: "protocol-match",
    status: "warn",
    detail: `herdr protocol ${protocol} != expected ${EXPECTED_PROTOCOL} (informational — daemon degrades that target to protocol-mismatch rather than assuming parity)`,
  };
}

export interface LaunchdCheckOpts {
  exec: ExecFn;
  uid: string;
  label?: string;
}

export async function checkLaunchdLoaded(opts: LaunchdCheckOpts): Promise<DoctorResult> {
  const label = opts.label ?? LAUNCHD_LABEL;
  const res = await opts.exec("launchctl", ["print", `gui/${opts.uid}/${label}`]);
  if (res.exitCode === 0) {
    return { name: "launchd-loaded", status: "ok", detail: `${label} loaded` };
  }
  return {
    name: "launchd-loaded",
    status: "fail",
    detail: `${label} not loaded (launchctl print exited ${res.exitCode})`,
    fix: "Run `herddeck install` to bootstrap the LaunchAgent.",
  };
}

export function checkRunDir(runDir: string, hasRemoteTargets: boolean): DoctorResult {
  if (!existsSync(runDir)) {
    // The daemon only creates run/ when remote targets exist (that's
    // where forwarded sockets live) — absence is normal otherwise.
    if (!hasRemoteTargets) {
      return {
        name: "run-dir",
        status: "ok",
        detail: `${runDir} not needed (no remote targets configured)`,
      };
    }
    return {
      name: "run-dir",
      status: "fail",
      detail: `missing: ${runDir}`,
      fix: `mkdir -p ${runDir} && chmod 700 ${runDir} (the daemon also creates this on startup).`,
    };
  }
  const mode = statSync(runDir).mode & 0o777;
  if (mode !== 0o700) {
    return {
      name: "run-dir",
      status: "fail",
      detail: `${runDir} has mode 0${mode.toString(8)} (expected 0700)`,
      fix: `chmod 700 ${runDir}`,
    };
  }
  return { name: "run-dir", status: "ok", detail: `${runDir} (0700)` };
}

/** Informational: TunnelManager opens forwarded sockets lazily
 * (docs/CONTRACTS.md), so an absent socket for a configured remote
 * target isn't an error by itself. */
export function checkRemoteTunnel(herddeckDir: string, targetName: string): DoctorResult {
  const socketPath = join(herddeckDir, "run", `${targetName}.sock`);
  if (existsSync(socketPath)) {
    return { name: `tunnel:${targetName}`, status: "ok", detail: socketPath };
  }
  return {
    name: `tunnel:${targetName}`,
    status: "warn",
    detail: `no local tunnel socket at ${socketPath} (informational — tunnels open lazily on first use)`,
  };
}

export interface RunDoctorOpts {
  exec: ExecFn;
  fetchImpl: FetchLike;
  daemonUrl: string;
  uid: string;
  herddeckDir: string;
  configPath: string;
  /** Fallback local socket path when `herdr status` can't be parsed. */
  localSocketPath: string;
}

export async function runDoctor(opts: RunDoctorOpts): Promise<DoctorResult[]> {
  const { result: herdrBinaryResult, herdrStatus } = await checkHerdrBinary(opts.exec);
  const socketPath = herdrStatus?.socket ?? opts.localSocketPath;
  const remoteTargets = readRemoteTargetNames(opts.configPath);
  const results: DoctorResult[] = [
    herdrBinaryResult,
    checkHerdrSocket(socketPath),
    await checkDaemonHealth({ url: opts.daemonUrl, fetchImpl: opts.fetchImpl }),
    checkProtocolMatch(herdrStatus),
    await checkLaunchdLoaded({ exec: opts.exec, uid: opts.uid }),
    checkRunDir(join(opts.herddeckDir, "run"), remoteTargets.length > 0),
  ];
  for (const name of remoteTargets) {
    results.push(checkRemoteTunnel(opts.herddeckDir, name));
  }
  return results;
}

export function formatDoctor(results: DoctorResult[]): string {
  const icons: Record<DoctorStatus, string> = { ok: "✅", warn: "⚠️", fail: "❌" };
  const nameWidth = Math.max(0, ...results.map((r) => r.name.length));
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${icons[r.status]} ${r.name.padEnd(nameWidth)}  ${r.detail}`);
    if (r.fix && r.status !== "ok") {
      lines.push(`   ${" ".repeat(nameWidth)}  fix: ${r.fix}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

interface HealthTargetLike {
  name?: string;
  kind?: string;
  state?: string;
  protocol?: number | null;
}

interface HealthAgentLike {
  target?: string;
  paneId?: string;
  name?: string | null;
  agentKind?: string | null;
  status?: string;
}

interface HealthResponse {
  ok?: boolean;
  version?: string;
  plugins?: number;
  targets?: HealthTargetLike[];
  // The daemon's current /health handler (packages/daemon/src/server.ts)
  // sends agents.length as a bare count; a richer per-agent array is a
  // plausible future shape (matches WsEvent's agents:update payload).
  // Handle both so this CLI doesn't break either way.
  agents?: HealthAgentLike[] | number;
}

function formatTable(headers: readonly string[], rows: readonly string[][]): string {
  if (rows.length === 0) return "(none)\n";
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const formatRow = (cells: readonly string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join("  ");
  return `${[formatRow(headers), ...rows.map(formatRow)].join("\n")}\n`;
}

function getPortArg(args: readonly string[]): number | undefined {
  const idx = args.indexOf("--port");
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function runStatus(
  args: readonly string[],
  opts: CliOptions,
  io: CliIO,
): Promise<number> {
  const port = getPortArg(args) ?? readConfiguredPort(opts.configPath);
  const url = `http://127.0.0.1:${port}/health`;

  let res: Response;
  try {
    res = await opts.fetchImpl(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(
      `herddeck: daemon not reachable on port ${port} (${msg}). Start it with \`herddeck install\` or \`bun packages/daemon/src/index.ts\`.\n`,
    );
    return 1;
  }
  if (!res.ok) {
    io.stderr(`herddeck: daemon not reachable on port ${port} (HTTP ${res.status}).\n`);
    return 1;
  }

  let body: HealthResponse;
  try {
    body = (await res.json()) as HealthResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`herddeck: could not parse daemon /health response: ${msg}\n`);
    return 1;
  }

  io.stdout(`daemon v${body.version ?? "unknown"} — ${body.plugins ?? 0} plugin connection(s)\n\n`);

  const targets = body.targets ?? [];
  io.stdout("Targets:\n");
  io.stdout(
    formatTable(
      ["NAME", "KIND", "STATE", "PROTOCOL"],
      targets.map((t) => [
        t.name ?? "?",
        t.kind ?? "?",
        t.state ?? "?",
        t.protocol != null ? String(t.protocol) : "-",
      ]),
    ),
  );

  io.stdout("\nAgents:\n");
  if (Array.isArray(body.agents)) {
    io.stdout(
      formatTable(
        ["TARGET", "PANE", "NAME/KIND", "STATUS"],
        body.agents.map((a) => [
          a.target ?? "?",
          a.paneId ?? "?",
          `${a.name ?? "(unnamed)"} (${a.agentKind ?? "?"})`,
          a.status ?? "?",
        ]),
      ),
    );
  } else {
    io.stdout(
      `${body.agents ?? 0} agent(s) connected (per-agent detail unavailable from this daemon)\n`,
    );
  }

  return 0;
}

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

export async function runInstall(opts: CliOptions, io: CliIO): Promise<number> {
  mkdirSync(opts.herddeckDir, { recursive: true });

  const daemonEntry = join(opts.repoRoot, "packages", "daemon", "src", "index.ts");
  const logPath = join(opts.herddeckDir, "daemon.log");
  const plistPath = join(opts.launchAgentsDir, `${LAUNCHD_LABEL}.plist`);

  writeLaunchAgentPlist(plistPath, { bunPath: opts.bunPath, daemonEntry, logPath });
  io.stdout(`wrote LaunchAgent plist: ${plistPath}\n`);

  const res = await opts.exec("launchctl", ["bootstrap", `gui/${opts.uid}`, plistPath]);
  if (res.exitCode !== 0) {
    io.stderr(
      `launchctl bootstrap exited ${res.exitCode}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}\n`,
    );
    io.stderr("you may need to run launchctl manually, or check launchd permissions.\n");
  } else {
    io.stdout(`bootstrapped ${LAUNCHD_LABEL} into gui/${opts.uid}\n`);
  }

  io.stdout(
    [
      "",
      "herddeck daemon installed.",
      `  logs:          ${logPath}`,
      "  check health:  herddeck doctor",
      "  inspect state: herddeck status",
      "",
      "Next: install the Stream Deck plugin (packages/plugin, SDK v2) via",
      "the Elgato Marketplace or `streamdeck link packages/plugin/com.nickboy.herddeck.sdPlugin`",
      "— see packages/plugin/README.md once the plugin ships.",
      "",
    ].join("\n"),
  );

  return res.exitCode === 0 ? 0 : 1;
}

export async function runUninstall(opts: CliOptions, io: CliIO): Promise<number> {
  const plistPath = join(opts.launchAgentsDir, `${LAUNCHD_LABEL}.plist`);

  if (!existsSync(plistPath)) {
    io.stdout("no LaunchAgent plist found; nothing to uninstall.\n");
    return 0;
  }

  const res = await opts.exec("launchctl", ["bootout", `gui/${opts.uid}/${LAUNCHD_LABEL}`]);
  if (res.exitCode !== 0) {
    io.stderr(
      `launchctl bootout exited ${res.exitCode}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}\n`,
    );
  }

  if (isLaunchAgentPlistOurs(plistPath)) {
    unlinkSync(plistPath);
    io.stdout(`removed ${plistPath}\n`);
  } else {
    io.stderr(`${plistPath} doesn't look like ours (label mismatch) — left in place.\n`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const USAGE = `Usage: herddeck <command> [...args]

Commands:
  status [--port N]    GET http://127.0.0.1:<port>/health and print the
                        daemon version, plugin connections, and a table
                        of targets + agents. Port defaults to the value
                        in ~/.herddeck/config.toml, else 9137.
  doctor                Health report: herdr on PATH + protocol, local
                        herdr socket, daemon /health, protocol match,
                        launchd job loaded, ~/.herddeck/run/ perms, and
                        (per remote target) local tunnel socket. Exits
                        non-zero if any check fails.
  install               Write ~/Library/LaunchAgents/${LAUNCHD_LABEL}.plist
                        (running \`bun packages/daemon/src/index.ts\`)
                        and bootstrap it via launchctl.
  uninstall              Reverse install: launchctl bootout + remove the
                        plist (only if it's ours).
  help, --help, -h      This message.
`;

export async function runCli(
  argv: readonly string[],
  opts: CliOptions,
  io: CliIO,
): Promise<number> {
  const [command, ...rest] = argv;
  if (!command) {
    io.stderr(USAGE);
    return 1;
  }
  switch (command) {
    case "--help":
    case "-h":
    case "help":
      io.stdout(USAGE);
      return 0;
    case "status":
      return runStatus(rest, opts, io);
    case "doctor": {
      const port = getPortArg(rest) ?? readConfiguredPort(opts.configPath);
      const results = await runDoctor({
        exec: opts.exec,
        fetchImpl: opts.fetchImpl,
        daemonUrl: `http://127.0.0.1:${port}/health`,
        uid: opts.uid,
        herddeckDir: opts.herddeckDir,
        configPath: opts.configPath,
        localSocketPath: join(opts.home, ".config", "herdr", "herdr.sock"),
      });
      io.stdout(`${formatDoctor(results)}\n`);
      return results.some((r) => r.status === "fail") ? 1 : 0;
    }
    case "install":
      return runInstall(opts, io);
    case "uninstall":
      return runUninstall(opts, io);
    default:
      io.stderr(`herddeck: unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

if (import.meta.main) {
  runCli(process.argv.slice(2), defaultCliOptions(), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  })
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
