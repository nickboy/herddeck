// Tests for scripts/herddeck-ctx-scan — the statusline-free route to the
// context donut. Driven for real: a fake herdr on a real unix socket, real
// transcript fixtures on disk, and the actual script as a subprocess.
//
// The cases that matter are the two this script got wrong when first run
// against live data: a rate-limited session whose transcript tail is all
// synthetic error records, and a pane herdr cannot resolve to a Claude
// session id.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "herddeck-ctx-scan");

let dir: string;
let sockPath: string;
let home: string;
let server: ReturnType<typeof Bun.listen> | null = null;
/** Every request the script sent, in order. */
let requests: Array<{ method: string; params: Record<string, unknown> }>;
/** What the fake herdr answers session.snapshot with. */
let snapshotAgents: unknown[];
/** pane_id -> pids reported by pane.process_info. */
let panePids: Record<string, number[]>;

interface Usage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** One assistant record as Claude Code writes them. */
function record(usage: Usage, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    message: { model: "claude-opus-5", usage, ...(extra.message ?? {}) },
    ...extra,
  });
}

/** The shape Claude Code appends when a session is rate-limited. */
function syntheticRecord(): string {
  return JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    message: {
      model: "<synthetic>",
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
}

function writeTranscript(sessionId: string, lines: string[]): void {
  const projects = join(home, ".claude", "projects", "-fixture");
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
}

function agent(paneId: string, sessionId: string | null, ctxPct?: string) {
  return {
    pane_id: paneId,
    agent: "claude",
    agent_status: "idle",
    agent_session: sessionId ? { source: "herdr:claude", kind: "id", value: sessionId } : null,
    ...(ctxPct ? { tokens: { ctx_pct: ctxPct } } : {}),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herddeck-ctx-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  sockPath = join(dir, "herdr.sock");
  requests = [];
  snapshotAgents = [];
  panePids = {};

  server = Bun.listen({
    unix: sockPath,
    socket: {
      data: (socket, data) => {
        for (const line of data.toString().split("\n")) {
          if (!line.trim()) continue;
          const req = JSON.parse(line) as { method: string; params: Record<string, unknown> };
          requests.push({ method: req.method, params: req.params });
          let result: unknown = { type: "ok" };
          if (req.method === "session.snapshot") {
            result = { snapshot: { agents: snapshotAgents, panes: [] } };
          } else if (req.method === "pane.process_info") {
            const pids = panePids[String(req.params.pane_id)] ?? [];
            result = {
              process_info: {
                shell_pid: pids[0] ?? 1,
                foreground_processes: pids.map((pid) => ({ pid, name: "node" })),
              },
            };
          }
          socket.write(`${JSON.stringify({ id: "x", result })}\n`);
        }
      },
      error: () => {},
    },
  });
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

/** Run one scan pass. `claudeAgents`, when given, becomes the JSON a stub
 * `claude agents --json` prints — the pid fallback's input. */
async function scan(claudeAgents?: unknown[]): Promise<string> {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  if (claudeAgents) {
    const stub = join(binDir, "claude");
    writeFileSync(stub, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(claudeAgents)}\nJSON\n`);
    chmodSync(stub, 0o755);
  }
  const proc = Bun.spawn(["python3", SCRIPT, "--socket", sockPath, "-v"], {
    env: {
      ...process.env,
      HOME: home,
      // Without a stub, the fallback must not reach a real `claude`.
      PATH: claudeAgents ? `${binDir}:/usr/bin:/bin` : "/usr/bin:/bin",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

function reportedFor(paneId: string): string | undefined {
  const req = requests.find(
    (r) => r.method === "pane.report_metadata" && r.params.pane_id === paneId,
  );
  return (req?.params.tokens as Record<string, string> | undefined)?.ctx_pct;
}

test("reports a percentage derived from the transcript's newest usage", async () => {
  writeTranscript("s1", [
    record({ cache_read_input_tokens: 1000 }),
    record({ input_tokens: 2, cache_creation_input_tokens: 708, cache_read_input_tokens: 432571 }),
  ]);
  snapshotAgents = [agent("w1:p1", "s1")];

  await scan();
  // 433281 / 1_000_000 -> 43, the figure the statusline reports for the
  // same session.
  expect(reportedFor("w1:p1")).toBe("43");
});

test("ignores the synthetic error records a rate-limited session ends with", async () => {
  // Live regression: six `<synthetic>` isApiErrorMessage records with
  // all-zero usage sat at the tail of a rate-limited session, and reading
  // the newest usage blindly reported 0% for a session at 34%.
  writeTranscript("s1", [
    record({ cache_read_input_tokens: 340813 }),
    syntheticRecord(),
    syntheticRecord(),
    syntheticRecord(),
  ]);
  snapshotAgents = [agent("w1:p1", "s1")];

  await scan();
  expect(reportedFor("w1:p1")).toBe("34");
});

test("falls back to matching a pane's pid when herdr has no session id", async () => {
  // Observed live: herdr resolved 3 of 4 Claude panes. `claude agents
  // --json` knows the rest, and herdr knows each pane's processes.
  writeTranscript("s2", [record({ cache_read_input_tokens: 500000 })]);
  snapshotAgents = [agent("w1:p2", null)];
  panePids["w1:p2"] = [111, 79119];

  const out = await scan([{ pid: 79119, sessionId: "s2" }]);
  expect(out).toContain("resolved via pid 79119");
  expect(reportedFor("w1:p2")).toBe("50");
});

test("skips a pane no route can resolve rather than guessing", async () => {
  snapshotAgents = [agent("w1:p3", null)];
  panePids["w1:p3"] = [222];

  const out = await scan([{ pid: 999, sessionId: "other" }]);
  expect(out).toContain("no Claude session id");
  expect(requests.some((r) => r.method === "pane.report_metadata")).toBe(false);
});

test("skips a session whose transcript is missing", async () => {
  snapshotAgents = [agent("w1:p1", "absent-session")];
  await scan();
  expect(requests.some((r) => r.method === "pane.report_metadata")).toBe(false);
});

test("writes nothing when the value herdr already holds is unchanged", async () => {
  // A key that redraws on every pass is churn the Stream Deck pays for.
  writeTranscript("s1", [record({ cache_read_input_tokens: 430000 })]);
  snapshotAgents = [agent("w1:p1", "s1", "43")];

  await scan();
  expect(requests.some((r) => r.method === "pane.report_metadata")).toBe(false);
});

test("clamps a session that overruns the assumed window to 100", async () => {
  // Rather than rendering a nonsensical 216% ring when the real window is
  // larger than the constant this script assumes.
  writeTranscript("s1", [record({ cache_read_input_tokens: 2_160_000 })]);
  snapshotAgents = [agent("w1:p1", "s1")];

  await scan();
  expect(reportedFor("w1:p1")).toBe("100");
});

test("honours HERDDECK_CONTEXT_WINDOW for a different window size", async () => {
  writeTranscript("s1", [record({ cache_read_input_tokens: 100_000 })]);
  snapshotAgents = [agent("w1:p1", "s1")];

  const proc = Bun.spawn(["python3", SCRIPT, "--socket", sockPath], {
    env: { ...process.env, HOME: home, HERDDECK_CONTEXT_WINDOW: "200000" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await new Response(proc.stdout).text();
  await proc.exited;
  expect(reportedFor("w1:p1")).toBe("50");
});

test("exits cleanly when herdr is not running", async () => {
  server?.stop(true);
  server = null;
  const proc = Bun.spawn(["python3", SCRIPT, "--socket", join(dir, "gone.sock")], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  expect(out).toBe("");
});
