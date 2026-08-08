// Tests for scripts/herddeck-report-ctx.sh — the one place HerdDeck
// writes a context percentage into herdr. Run for real against a real
// unix socket: the script is deliberately silent on every failure
// path, so only observing the wire tells you whether it worked.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "herddeck-report-ctx.sh");

let dir: string;
let sockPath: string;
let server: ReturnType<typeof Bun.listen> | null = null;
let firstLine: Promise<string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herddeck-report-ctx-"));
  sockPath = join(dir, "herdr.sock");
  let resolve: (line: string) => void;
  firstLine = new Promise<string>((r) => {
    resolve = r;
  });
  server = Bun.listen({
    unix: sockPath,
    socket: { data: (_s, data) => resolve(data.toString()), error: () => {} },
  });
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

interface Env {
  paneId?: string | null;
  socketPath?: string | null;
}

/** process.env minus herdr's injection — these tests must not inherit
 * the pane the test runner itself happens to be running in. */
function baseEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "HERDR_PANE_ID" && k !== "HERDR_SOCKET_PATH"),
  ) as Record<string, string>;
}

async function run(arg: string | null, { paneId, socketPath }: Env = {}): Promise<number> {
  const env = baseEnv();
  if (paneId !== null) env.HERDR_PANE_ID = paneId ?? "w1:p1";
  if (socketPath !== null) env.HERDR_SOCKET_PATH = socketPath ?? sockPath;
  const proc = Bun.spawn(arg === null ? ["sh", SCRIPT] : ["sh", SCRIPT, arg], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  // Nothing may ever reach the caller's prompt.
  expect(out).toBe("");
  expect(err).toBe("");
  return await proc.exited;
}

/** The script writes synchronously and has already exited by the time
 * run() resolves, so a short grace period is enough for the listener
 * to be scheduled — a long one would only slow the negative cases. */
async function reported(): Promise<string | null> {
  return await Promise.race([firstLine, new Promise<null>((r) => setTimeout(() => r(null), 300))]);
}

function requestOf(line: string) {
  return JSON.parse(line.trim()) as {
    id: string;
    method: string;
    params: { pane_id: string; source: string; tokens: Record<string, string> };
  };
}

test("writes a pane.report_metadata request carrying ctx_pct", async () => {
  expect(await run("60")).toBe(0);
  const req = requestOf((await reported()) as string);
  expect(req.method).toBe("pane.report_metadata");
  expect(req.params.pane_id).toBe("w1:p1");
  expect(req.params.source).toBe("herddeck-statusline");
  expect(req.params.tokens).toEqual({ ctx_pct: "60" });
});

test("emits one newline-terminated NDJSON line", async () => {
  await run("60");
  const line = (await reported()) as string;
  expect(line.endsWith("\n")).toBe(true);
  expect(line.trimEnd().includes("\n")).toBe(false);
});

test("rounds a fractional percentage to the nearest integer", async () => {
  await run("60.6");
  expect(requestOf((await reported()) as string).params.tokens.ctx_pct).toBe("61");
});

test("reports a literal 0 rather than treating it as absent", async () => {
  await run("0");
  expect(requestOf((await reported()) as string).params.tokens.ctx_pct).toBe("0");
});

test.each([
  ["a non-numeric argument", "lots"],
  ["a negative percentage", "-5"],
  ["an out-of-range percentage", "150"],
  ["an empty argument", ""],
])("reports nothing for %s", async (_label, arg) => {
  expect(await run(arg)).toBe(0);
  expect(await reported()).toBeNull();
});

test("reports nothing when called with no argument at all", async () => {
  expect(await run(null)).toBe(0);
  expect(await reported()).toBeNull();
});

test("reports nothing outside a herdr pane", async () => {
  expect(await run("60", { paneId: null })).toBe(0);
  expect(await reported()).toBeNull();
});

test("succeeds silently when the herdr socket does not exist", async () => {
  // A stopped herdr server must degrade to a dark donut, never to a
  // broken prompt or a non-zero exit in the caller's statusline.
  expect(await run("60", { socketPath: join(dir, "absent.sock") })).toBe(0);
  expect(await reported()).toBeNull();
});
