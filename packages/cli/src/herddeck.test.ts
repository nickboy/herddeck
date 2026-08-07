import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CliOptions,
  type DoctorResult,
  type ExecFn,
  LAUNCHD_LABEL,
  buildLaunchAgentPlist,
  checkProtocolMatch,
  checkRunDir,
  formatDoctor,
  isLaunchAgentPlistOurs,
  parseHerdrStatus,
  readConfiguredPort,
  readRemoteTargetNames,
  runCli,
  writeLaunchAgentPlist,
} from "./herddeck";

let dir: string;
let herddeckDir: string;
let launchAgentsDir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herddeck-cli-"));
  herddeckDir = join(dir, ".herddeck");
  launchAgentsDir = join(dir, "LaunchAgents");
  configPath = join(herddeckDir, "config.toml");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const captureOutput = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    get out() {
      return out.join("");
    },
    get err() {
      return err.join("");
    },
  };
};

const noopExec: ExecFn = async () => ({ stdout: "", stderr: "", exitCode: 0 });
const okFetch = (async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch;

const baseOpts = (override: Partial<CliOptions> = {}): CliOptions => ({
  home: dir,
  herddeckDir,
  configPath,
  launchAgentsDir,
  repoRoot: "/fake/repo",
  bunPath: "/fake/bin/bun",
  uid: "501",
  fetchImpl: okFetch,
  exec: noopExec,
  ...override,
});

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

describe("CLI dispatch", () => {
  test("--help prints usage and exits 0", async () => {
    const io = captureOutput();
    const code = await runCli(["--help"], baseOpts(), io);
    expect(code).toBe(0);
    expect(io.out).toContain("Usage: herddeck");
    expect(io.out).toContain("status");
    expect(io.out).toContain("doctor");
    expect(io.out).toContain("install");
    expect(io.out).toContain("uninstall");
  });

  test("help prints usage and exits 0", async () => {
    const io = captureOutput();
    const code = await runCli(["help"], baseOpts(), io);
    expect(code).toBe(0);
    expect(io.out).toContain("Usage: herddeck");
  });

  test("no args prints usage to stderr and exits 1", async () => {
    const io = captureOutput();
    const code = await runCli([], baseOpts(), io);
    expect(code).toBe(1);
    expect(io.err).toContain("Usage: herddeck");
  });

  test("unknown command prints error and exits 1", async () => {
    const io = captureOutput();
    const code = await runCli(["wharrgarbl"], baseOpts(), io);
    expect(code).toBe(1);
    expect(io.err).toContain("unknown command");
  });
});

// ---------------------------------------------------------------------------
// port reader
// ---------------------------------------------------------------------------

describe("readConfiguredPort", () => {
  test("defaults to 9137 when config file is missing", () => {
    expect(readConfiguredPort(join(dir, "missing.toml"))).toBe(9137);
  });

  test("parses port from [daemon] section", () => {
    const p = join(dir, "config.toml");
    writeFileSync(p, "[daemon]\nport = 8080\n");
    expect(readConfiguredPort(p)).toBe(8080);
  });

  test("tolerates extra whitespace around =", () => {
    const p = join(dir, "config.toml");
    writeFileSync(p, "[daemon]\nport   =   6000\n");
    expect(readConfiguredPort(p)).toBe(6000);
  });

  test("defaults to 9137 when port key is absent", () => {
    const p = join(dir, "config.toml");
    writeFileSync(p, '[ui]\nterminal_app = "Ghostty"\n');
    expect(readConfiguredPort(p)).toBe(9137);
  });

  test("defaults to 9137 on an empty file", () => {
    const p = join(dir, "config.toml");
    writeFileSync(p, "");
    expect(readConfiguredPort(p)).toBe(9137);
  });
});

// ---------------------------------------------------------------------------
// remote target reader
// ---------------------------------------------------------------------------

describe("readRemoteTargetNames", () => {
  test("empty when config file is missing", () => {
    expect(readRemoteTargetNames(join(dir, "missing.toml"))).toEqual([]);
  });

  test("returns only remote target names, skipping local", () => {
    const p = join(dir, "config.toml");
    writeFileSync(
      p,
      `[[targets]]
name = "local"
kind = "local"

[[targets]]
name = "workbox"
kind = "remote"
host = "workbox"
remote_socket = "~/.config/herdr/herdr.sock"

[[targets]]
name = "gpu-box"
kind = "remote"
host = "gpu-box"
`,
    );
    expect(readRemoteTargetNames(p)).toEqual(["workbox", "gpu-box"]);
  });

  test("stops each target block at the next table marker", () => {
    const p = join(dir, "config.toml");
    writeFileSync(
      p,
      `[[targets]]
name = "workbox"
kind = "remote"
host = "workbox"

[ui]
terminal_app = "Ghostty"
`,
    );
    expect(readRemoteTargetNames(p)).toEqual(["workbox"]);
  });

  test("empty when only local targets configured", () => {
    const p = join(dir, "config.toml");
    writeFileSync(p, `[[targets]]\nname = "local"\nkind = "local"\n`);
    expect(readRemoteTargetNames(p)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// launchd plist
// ---------------------------------------------------------------------------

describe("buildLaunchAgentPlist", () => {
  test("contains the herddeck label by default", () => {
    const plist = buildLaunchAgentPlist({
      bunPath: "/fake/bin/bun",
      daemonEntry: "/fake/repo/packages/daemon/src/index.ts",
      logPath: "/fake/log.log",
    });
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
  });

  test("accepts a custom label", () => {
    const plist = buildLaunchAgentPlist({
      label: "com.custom.label",
      bunPath: "/x",
      daemonEntry: "/y",
      logPath: "/z",
    });
    expect(plist).toContain("<string>com.custom.label</string>");
    expect(plist).not.toContain(LAUNCHD_LABEL);
  });

  test("ProgramArguments is [bunPath, daemonEntry] in that order", () => {
    const plist = buildLaunchAgentPlist({
      bunPath: "/opt/homebrew/bin/bun",
      daemonEntry: "/Users/nick/herddeck/packages/daemon/src/index.ts",
      logPath: "/tmp/x.log",
    });
    const programArgsBlock =
      plist.split("<key>ProgramArguments</key>")[1]?.split("</array>")[0] ?? "";
    const bunIdx = programArgsBlock.indexOf("/opt/homebrew/bin/bun");
    const entryIdx = programArgsBlock.indexOf("packages/daemon/src/index.ts");
    expect(bunIdx).toBeGreaterThanOrEqual(0);
    expect(entryIdx).toBeGreaterThan(bunIdx);
  });

  test("wires StandardOutPath and StandardErrorPath to the log path", () => {
    const plist = buildLaunchAgentPlist({
      bunPath: "/x",
      daemonEntry: "/y",
      logPath: "/tmp/herddeck-daemon.log",
    });
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist).toContain("<string>/tmp/herddeck-daemon.log</string>");
  });

  test("KeepAlive and RunAtLoad are both true", () => {
    const plist = buildLaunchAgentPlist({ bunPath: "/x", daemonEntry: "/y", logPath: "/z" });
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  });

  test("output starts with the standard XML/DOCTYPE preamble", () => {
    const plist = buildLaunchAgentPlist({ bunPath: "/x", daemonEntry: "/y", logPath: "/z" });
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist).toContain("<!DOCTYPE plist PUBLIC");
  });

  test("escapes XML-special characters in paths", () => {
    const plist = buildLaunchAgentPlist({
      bunPath: "/weird/<x>&'\".bun",
      daemonEntry: "/y",
      logPath: "/z",
    });
    expect(plist).toContain("&lt;x&gt;&amp;&apos;&quot;.bun");
  });

  test.skipIf(process.platform !== "darwin")("passes macOS `plutil -lint` validation", async () => {
    const target = join(dir, "validate.plist");
    writeLaunchAgentPlist(target, { bunPath: "/x", daemonEntry: "/y", logPath: "/z" });
    const proc = Bun.spawn(["plutil", "-lint", target], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});

describe("writeLaunchAgentPlist / isLaunchAgentPlistOurs", () => {
  test("writes plist to the target path", () => {
    const target = join(dir, `${LAUNCHD_LABEL}.plist`);
    writeLaunchAgentPlist(target, { bunPath: "/x", daemonEntry: "/y", logPath: "/z" });
    const content = readFileSync(target, "utf8");
    expect(content).toContain(`<string>${LAUNCHD_LABEL}</string>`);
  });

  test("isLaunchAgentPlistOurs is true for a matching label", () => {
    const target = join(dir, "candidate.plist");
    writeLaunchAgentPlist(target, { bunPath: "/x", daemonEntry: "/y", logPath: "/z" });
    expect(isLaunchAgentPlistOurs(target)).toBe(true);
  });

  test("isLaunchAgentPlistOurs is false for a different label", () => {
    const target = join(dir, "stranger.plist");
    writeLaunchAgentPlist(target, {
      label: "org.other.tool",
      bunPath: "/x",
      daemonEntry: "/y",
      logPath: "/z",
    });
    expect(isLaunchAgentPlistOurs(target)).toBe(false);
  });

  test("isLaunchAgentPlistOurs is false when file does not exist", () => {
    expect(isLaunchAgentPlistOurs(join(dir, "missing.plist"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// herdr status parsing
// ---------------------------------------------------------------------------

describe("parseHerdrStatus", () => {
  const sample = `client:
  version: 0.8.0
  channel: stable
  protocol: 19

server:
  status: running
  version: 0.8.0
  protocol: 19
  compatible: yes
  socket: /Users/nick/.config/herdr/herdr.sock

update:
  restart_needed: no
`;

  test("parses client + server sections", () => {
    const parsed = parseHerdrStatus(sample);
    expect(parsed.clientVersion).toBe("0.8.0");
    expect(parsed.clientProtocol).toBe(19);
    expect(parsed.serverRunning).toBe(true);
    expect(parsed.serverVersion).toBe("0.8.0");
    expect(parsed.serverProtocol).toBe(19);
    expect(parsed.socket).toBe("/Users/nick/.config/herdr/herdr.sock");
  });

  test("serverRunning is false when server.status is not 'running'", () => {
    const output = `client:
  version: 0.8.0
  protocol: 19

server:
  status: stopped
`;
    const parsed = parseHerdrStatus(output);
    expect(parsed.serverRunning).toBe(false);
    expect(parsed.clientProtocol).toBe(19);
  });

  test("handles empty output without throwing", () => {
    const parsed = parseHerdrStatus("");
    expect(parsed.serverRunning).toBe(false);
    expect(parsed.clientProtocol).toBeNull();
    expect(parsed.socket).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// doctor checks
// ---------------------------------------------------------------------------

describe("doctor checks", () => {
  test("checkProtocolMatch is ok when protocol matches 19", () => {
    const result = checkProtocolMatch({
      clientVersion: "0.8.0",
      clientProtocol: 19,
      serverRunning: true,
      serverVersion: "0.8.0",
      serverProtocol: 19,
      socket: "/x",
    });
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("informational");
  });

  test("checkProtocolMatch warns (never fails) on mismatch", () => {
    const result = checkProtocolMatch({
      clientVersion: "0.8.0",
      clientProtocol: 20,
      serverRunning: true,
      serverVersion: "0.8.0",
      serverProtocol: 20,
      socket: "/x",
    });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("informational");
    expect(result.detail).toContain("20");
  });

  test("checkProtocolMatch warns when herdr status is unavailable", () => {
    const result = checkProtocolMatch(null);
    expect(result.status).toBe("warn");
  });

  test("checkRunDir fails when directory is missing and remote targets exist", () => {
    const result = checkRunDir(join(dir, "does-not-exist"), true);
    expect(result.status).toBe("fail");
    expect(result.fix).toBeDefined();
  });

  test("checkRunDir fails on wrong perms", () => {
    const runDir = join(dir, "run");
    mkdirSync(runDir, { mode: 0o755 });
    const result = checkRunDir(runDir, true);
    expect(result.status).toBe("fail");
    expect(result.fix).toContain("chmod 700");
  });

  test("checkRunDir is ok when missing but no remote targets configured", () => {
    const result = checkRunDir(join(dir, "does-not-exist"), false);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("not needed");
  });

  test("checkRunDir is ok when perms are 0700", () => {
    const runDir = join(dir, "run");
    mkdirSync(runDir, { mode: 0o700 });
    const result = checkRunDir(runDir, true);
    expect(result.status).toBe("ok");
  });
});

describe("formatDoctor", () => {
  test("formats ok/warn/fail with icons, aligns names, includes fix hints for non-ok", () => {
    const results: DoctorResult[] = [
      { name: "a", status: "ok", detail: "fine" },
      { name: "bb", status: "warn", detail: "meh", fix: "do X" },
      { name: "ccc", status: "fail", detail: "broken", fix: "do Y" },
    ];
    const out = formatDoctor(results);
    expect(out).toContain("✅ a");
    expect(out).toContain("⚠️");
    expect(out).toContain("❌");
    expect(out).toContain("fix: do X");
    expect(out).toContain("fix: do Y");
    // ok entries never get a fix line, even if one were present.
    expect(out.split("\n").length).toBe(5); // 3 result lines + 2 fix lines
  });

  test("handles an empty result list", () => {
    expect(formatDoctor([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// herddeck doctor (full flow, injected exec/fetch)
// ---------------------------------------------------------------------------

describe("herddeck doctor", () => {
  test("runs all checks and includes a remote tunnel row per remote target", async () => {
    mkdirSync(herddeckDir, { recursive: true });
    mkdirSync(join(herddeckDir, "run"), { recursive: true, mode: 0o700 });
    writeFileSync(
      configPath,
      `[[targets]]
name = "local"
kind = "local"

[[targets]]
name = "workbox"
kind = "remote"
host = "workbox"
`,
    );

    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "herdr" && args[0] === "status") {
        return {
          stdout:
            "client:\n  version: 0.8.0\n  protocol: 19\n\nserver:\n  status: running\n  version: 0.8.0\n  protocol: 19\n  socket: /fake/herdr.sock\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (cmd === "launchctl" && args[0] === "print") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true, version: "0.1.0" }))) as unknown as typeof fetch;

    const io = captureOutput();
    const code = await runCli(["doctor"], baseOpts({ exec, fetchImpl }), io);

    expect(io.out).toContain("herdr-binary");
    expect(io.out).toContain("herdr-socket");
    expect(io.out).toContain("daemon-health");
    expect(io.out).toContain("protocol-match");
    expect(io.out).toContain("launchd-loaded");
    expect(io.out).toContain("run-dir");
    expect(io.out).toContain("tunnel:workbox");
    expect(code).toBe(0);
  });

  test("exits 1 when any check fails (e.g. launchd not loaded)", async () => {
    mkdirSync(herddeckDir, { recursive: true });
    mkdirSync(join(herddeckDir, "run"), { recursive: true, mode: 0o700 });

    const exec: ExecFn = async (cmd, args) => {
      if (cmd === "herdr" && args[0] === "status") {
        return { stdout: "", stderr: "not found", exitCode: 127 };
      }
      if (cmd === "launchctl") {
        return { stdout: "", stderr: "No such process", exitCode: 3 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const io = captureOutput();
    const code = await runCli(["doctor"], baseOpts({ exec, fetchImpl }), io);
    expect(code).toBe(1);
    expect(io.out).toContain("❌");
  });
});

// ---------------------------------------------------------------------------
// herddeck status
// ---------------------------------------------------------------------------

describe("herddeck status", () => {
  test("prints daemon version, plugin count, and target + agent tables", async () => {
    const fakeBody = {
      ok: true,
      version: "0.1.0",
      plugins: 2,
      targets: [{ name: "local", kind: "local", state: "online", protocol: 19 }],
      agents: [
        {
          target: "local",
          paneId: "w1:p1",
          name: "worker",
          agentKind: "claude",
          status: "working",
        },
      ],
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(fakeBody), { status: 200 })) as unknown as typeof fetch;
    const io = captureOutput();
    const code = await runCli(["status"], baseOpts({ fetchImpl }), io);
    expect(code).toBe(0);
    expect(io.out).toContain("daemon v0.1.0");
    expect(io.out).toContain("2 plugin connection(s)");
    expect(io.out).toContain("local");
    expect(io.out).toContain("w1:p1");
    expect(io.out).toContain("working");
  });

  test("falls back to a bare agent count when agents is a number", async () => {
    const fakeBody = { ok: true, version: "0.1.0", plugins: 0, targets: [], agents: 3 };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(fakeBody), { status: 200 })) as unknown as typeof fetch;
    const io = captureOutput();
    const code = await runCli(["status"], baseOpts({ fetchImpl }), io);
    expect(code).toBe(0);
    expect(io.out).toContain("3 agent(s) connected");
  });

  test("respects --port over config.toml", async () => {
    mkdirSync(herddeckDir, { recursive: true });
    writeFileSync(configPath, "[daemon]\nport = 1234\n");
    let requestedUrl = "";
    const fetchImpl = (async (input: string | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ ok: true, targets: [], agents: [] }));
    }) as unknown as typeof fetch;
    const io = captureOutput();
    await runCli(["status", "--port", "5555"], baseOpts({ fetchImpl }), io);
    expect(requestedUrl).toBe("http://127.0.0.1:5555/health");
  });

  test("daemon down: clear message on stderr + exit 1", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9137");
    }) as unknown as typeof fetch;
    const io = captureOutput();
    const code = await runCli(["status"], baseOpts({ fetchImpl }), io);
    expect(code).toBe(1);
    expect(io.err.toLowerCase()).toContain("not reachable");
  });

  test("non-ok HTTP status: clear message + exit 1", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const io = captureOutput();
    const code = await runCli(["status"], baseOpts({ fetchImpl }), io);
    expect(code).toBe(1);
    expect(io.err).toContain("not reachable");
  });
});

// ---------------------------------------------------------------------------
// herddeck install / uninstall
// ---------------------------------------------------------------------------

describe("herddeck install / uninstall", () => {
  test("install writes the plist and bootstraps via the injected exec (no real launchctl)", async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const io = captureOutput();
    const code = await runCli(
      ["install"],
      baseOpts({ exec, repoRoot: "/fake/repo", bunPath: "/fake/bin/bun", uid: "501" }),
      io,
    );
    expect(code).toBe(0);

    const plistPath = join(launchAgentsDir, `${LAUNCHD_LABEL}.plist`);
    expect(existsSync(plistPath)).toBe(true);
    const content = readFileSync(plistPath, "utf8");
    expect(content).toContain("/fake/bin/bun");
    expect(content).toContain("/fake/repo/packages/daemon/src/index.ts");
    expect(content).toContain(join(herddeckDir, "daemon.log"));

    expect(calls).toEqual([{ cmd: "launchctl", args: ["bootstrap", "gui/501", plistPath] }]);
    expect(io.out).toContain("herddeck daemon installed");
  });

  test("install reports failure (nonzero exit) when launchctl bootstrap fails", async () => {
    const exec: ExecFn = async () => ({ stdout: "", stderr: "boom", exitCode: 5 });
    const io = captureOutput();
    const code = await runCli(["install"], baseOpts({ exec }), io);
    expect(code).toBe(1);
    expect(io.err).toContain("boom");
  });

  test("uninstall boots out and removes our plist", async () => {
    const plistPath = join(launchAgentsDir, `${LAUNCHD_LABEL}.plist`);
    writeLaunchAgentPlist(plistPath, {
      bunPath: "/fake/bin/bun",
      daemonEntry: "/fake/repo/packages/daemon/src/index.ts",
      logPath: "/fake/log.log",
    });

    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const io = captureOutput();
    const code = await runCli(["uninstall"], baseOpts({ exec, uid: "501" }), io);
    expect(code).toBe(0);
    expect(existsSync(plistPath)).toBe(false);
    expect(calls).toEqual([{ cmd: "launchctl", args: ["bootout", `gui/501/${LAUNCHD_LABEL}`] }]);
  });

  test("uninstall is a no-op when no plist exists", async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const io = captureOutput();
    const code = await runCli(["uninstall"], baseOpts({ exec }), io);
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(io.out).toContain("nothing to uninstall");
  });

  test("uninstall leaves a foreign plist alone", async () => {
    const plistPath = join(launchAgentsDir, `${LAUNCHD_LABEL}.plist`);
    writeLaunchAgentPlist(plistPath, {
      label: "org.other.tool",
      bunPath: "/x",
      daemonEntry: "/y",
      logPath: "/z",
    });
    const io = captureOutput();
    const code = await runCli(["uninstall"], baseOpts({ exec: noopExec }), io);
    expect(code).toBe(0);
    expect(existsSync(plistPath)).toBe(true);
    expect(io.err).toContain("label mismatch");
  });
});
