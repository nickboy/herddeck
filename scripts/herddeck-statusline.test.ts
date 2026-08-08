// End-to-end tests for scripts/herddeck-statusline.sh — the script is
// run for real against a real unix socket, because the bug this file
// exists to prevent was a pure field-name typo (`.percentUsed` instead
// of `.context_window.used_percentage`) that no unit test of the
// surrounding TypeScript could have caught: the script is designed to
// fail silently, so a wrong field name produces no error, no output,
// and no report — just a donut that never lights up.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "herddeck-statusline.sh");

let dir: string;
let sockPath: string;
let server: ReturnType<typeof Bun.listen> | null = null;
/** Resolves with the first NDJSON line the script writes to the socket. */
let firstLine: Promise<string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herddeck-statusline-"));
  sockPath = join(dir, "herdr.sock");
  let resolve: (line: string) => void;
  firstLine = new Promise<string>((r) => {
    resolve = r;
  });
  server = Bun.listen({
    unix: sockPath,
    socket: {
      data: (_s, data) => resolve(data.toString()),
      // herdr answers one request per connection then closes; the
      // script never reads a reply, so nothing else is needed here.
      error: () => {},
    },
  });
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  exitCode: number;
}

/** process.env minus herdr's injection — these tests must not inherit
 * the pane the test runner itself happens to be running in. */
function baseEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "HERDR_PANE_ID" && k !== "HERDR_SOCKET_PATH"),
  ) as Record<string, string>;
}

/** Run the script with `input` on stdin. `paneId` null = no herdr env. */
async function run(input: string, paneId: string | null = "w1:p1"): Promise<RunResult> {
  const env = baseEnv();
  if (paneId !== null) {
    env.HERDR_PANE_ID = paneId;
    env.HERDR_SOCKET_PATH = sockPath;
  }
  const proc = Bun.spawn(["sh", SCRIPT], { stdin: new TextEncoder().encode(input), env });
  const stdout = await new Response(proc.stdout).text();
  return { stdout, exitCode: await proc.exited };
}

/** The report is backgrounded (`&`), so it can land after the script
 * exits; resolve against a timeout rather than assuming it's there. */
async function reported(): Promise<string | null> {
  return await Promise.race([firstLine, new Promise<null>((r) => setTimeout(() => r(null), 1000))]);
}

function tokensOf(line: string): Record<string, string> {
  const req = JSON.parse(line.trim()) as {
    method: string;
    params: { pane_id: string; source: string; tokens: Record<string, string> };
  };
  expect(req.method).toBe("pane.report_metadata");
  expect(req.params.pane_id).toBe("w1:p1");
  expect(req.params.source).toBe("herddeck-statusline");
  return req.params.tokens;
}

test("reports context_window.used_percentage as ctx_pct", async () => {
  // The exact field Claude Code emits. This is the regression guard.
  await run(JSON.stringify({ context_window: { used_percentage: 60 } }));
  const line = await reported();
  expect(line).not.toBeNull();
  expect(tokensOf(line as string).ctx_pct).toBe("60");
});

test("accepts a fractional used_percentage, rounding to the nearest int", async () => {
  await run(JSON.stringify({ context_window: { used_percentage: 60.6 } }));
  expect(tokensOf((await reported()) as string).ctx_pct).toBe("61");
});

test("falls back to percentUsed when used_percentage is absent", async () => {
  await run(JSON.stringify({ context_window: { percentUsed: 42 } }));
  expect(tokensOf((await reported()) as string).ctx_pct).toBe("42");
});

test("prefers used_percentage when both field spellings are present", async () => {
  await run(JSON.stringify({ context_window: { used_percentage: 77, percentUsed: 10 } }));
  expect(tokensOf((await reported()) as string).ctx_pct).toBe("77");
});

test("reports 0 rather than skipping an empty context window", async () => {
  // `// empty` on a literal 0 would drop it; 0% is a real reading and
  // must clear a stale donut instead of leaving the old value frozen.
  await run(JSON.stringify({ context_window: { used_percentage: 0 } }));
  expect(tokensOf((await reported()) as string).ctx_pct).toBe("0");
});

test("reports nothing when herdr env vars are absent", async () => {
  const res = await run(JSON.stringify({ context_window: { used_percentage: 60 } }), null);
  expect(res.exitCode).toBe(0);
  expect(await reported()).toBeNull();
});

test("reports nothing for a non-numeric percentage", async () => {
  await run(JSON.stringify({ context_window: { used_percentage: "lots" } }));
  expect(await reported()).toBeNull();
});

test("survives malformed stdin without output or failure", async () => {
  const res = await run("not json at all");
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toBe("");
  expect(await reported()).toBeNull();
});

test("echoes an upstream statusline's display text verbatim", async () => {
  const display = "🤖 Opus 5 │ 💰 $1.23 │ ███░░ 60% ctx";
  const res = await run(JSON.stringify({ display, context_window: { used_percentage: 60 } }));
  expect(res.stdout).toBe(`${display}\n`);
});

test("prints nothing when there is no upstream display text", async () => {
  const res = await run(JSON.stringify({ context_window: { used_percentage: 60 } }));
  expect(res.stdout).toBe("");
});
