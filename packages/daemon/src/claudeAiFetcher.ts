/**
 * Fetches Claude Max plan-usage from Anthropic's OAuth usage endpoint.
 *
 * Auth: reads the OAuth access token Claude Code stores in the macOS
 * Keychain under service `Claude Code-credentials` (JSON blob keyed
 * `claudeAiOauth.accessToken`). Users don't paste anything — the token
 * is already there as soon as they `claude login`.
 *
 * Endpoint + response-shape handling (defensive field-name variants,
 * 401/403/429/timeout policy) adapted from puritysb/AgentDeck
 * (`bridge/src/usage-api.ts`, MIT, © 2025 SerendipityBound). See
 * NOTICE.md.
 */

import { logInfo } from "./log";
import type { PlanMetric, PlanUsageSnapshot } from "./planTypes";

export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProcResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CredentialsReader = () => Promise<ProcResult>;

export type PlanFetcher = (_unused?: string) => Promise<PlanUsageSnapshot | { error: string }>;

export interface ClaudeAiFetcherOptions {
  url?: string;
  httpFetch?: HttpFetch;
  /** Injection: spawns `security find-generic-password ...` in production. */
  readCredentials?: CredentialsReader;
  /** Injection: `Date.now` in production. */
  clock?: () => number;
  /** Request timeout ms; default 10_000. */
  timeoutMs?: number;
}

const DEFAULT_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

const defaultReadCredentials: CredentialsReader = async () => {
  const proc = Bun.spawn(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};

export function makeClaudeAiFetcher(opts: ClaudeAiFetcherOptions = {}): PlanFetcher {
  const url = opts.url ?? DEFAULT_URL;
  const httpFetch: HttpFetch = opts.httpFetch ?? ((u, init) => fetch(u, init));
  const readCredentials = opts.readCredentials ?? defaultReadCredentials;
  const clock = opts.clock ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return async () => {
    const creds = await loadAccessToken(readCredentials);
    if ("error" in creds) return creds;

    let res: Response;
    try {
      res = await httpFetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "anthropic-beta": OAUTH_BETA_HEADER,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `fetch failed: ${msg}` };
    }

    if (res.status === 401 || res.status === 403) {
      return { error: "access token expired or invalid" };
    }
    if (!res.ok) {
      return { error: await formatHttpError(res) };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { error: "usage endpoint returned non-JSON" };
    }

    logResponseShape(body);
    return parsePlanUsageResponse(body, clock());
  };
}

/**
 * Build a richer error string for non-ok HTTP responses. Captures the
 * `Retry-After` header (so 429 backoff can honour it) and a snippet of
 * the response body (so daemon.log shows Anthropic's actual error
 * message instead of just the status code). Body is best-effort: a
 * non-readable stream or non-text body falls back to the bare status.
 *
 * Format:
 *   `HTTP 429 retry-after=272 body={"error":...}`
 *   `HTTP 500 body=<empty>`
 *
 * Length-capped at ~240 chars total so daemon.log lines stay greppable.
 */
export async function formatHttpError(res: Response): Promise<string> {
  const parts = [`HTTP ${res.status}`];
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) parts.push(`retry-after=${retryAfter}`);
  try {
    const raw = await res.text();
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      parts.push("body=<empty>");
    } else {
      const truncated = trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
      parts.push(`body=${truncated}`);
    }
  } catch {
    // body read failed (stream consumed, network error mid-read, etc) —
    // status alone is still useful.
  }
  return parts.join(" ");
}

// One-time log of the response's top-level keys so we discover any new
// buckets Anthropic adds (e.g. the recent "Claude Design" weekly limit
// the user spotted) without changing code first. Logs only when the
// shape differs from what we've seen — keeps the daemon log clean once
// the shape is stable.
let lastLoggedKeys: string | null = null;
function logResponseShape(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const keys = Object.keys(body as Record<string, unknown>).sort();
  const fingerprint = keys.join(",");
  if (fingerprint === lastLoggedKeys) return;
  lastLoggedKeys = fingerprint;
  logInfo(`plan response shape: keys=[${fingerprint}]`);
}

export async function loadAccessToken(
  readCredentials: CredentialsReader,
): Promise<{ accessToken: string; expiresAt: number | null } | { error: string }> {
  let result: ProcResult;
  try {
    result = await readCredentials();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `keychain read failed: ${msg}` };
  }
  if (result.exitCode !== 0) {
    return {
      error: "no Claude Code credentials in Keychain — run `claude login` first",
    };
  }
  const raw = result.stdout.trim();
  if (!raw) return { error: "keychain entry empty" };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { error: "keychain entry is not JSON" };
  }

  const oauth = (parsed.claudeAiOauth ?? parsed.oauth ?? {}) as Record<string, unknown>;
  const accessToken =
    typeof oauth.accessToken === "string"
      ? oauth.accessToken
      : typeof oauth.access_token === "string"
        ? oauth.access_token
        : undefined;
  if (!accessToken) return { error: "credentials missing accessToken" };

  const expiresAt =
    typeof oauth.expiresAt === "number"
      ? oauth.expiresAt
      : typeof oauth.expires_at === "number"
        ? oauth.expires_at
        : null;

  return { accessToken, expiresAt };
}

/**
 * Walk the usage endpoint's response JSON and extract every metric
 * we can recognise. Three explicit buckets (fiveHour / sevenDay /
 * extraUsage) plus a generic pass that picks up any `*_weekly` /
 * `weekly_*` key Anthropic adds later — most recently the "Claude
 * Design" weekly limit, which the user's screenshot showed but
 * which we never plucked because the key name wasn't in our list.
 * Defensive against field renames — matches the shape AgentDeck
 * handles upstream.
 */
export function parsePlanUsageResponse(body: unknown, fetchedAt: number): PlanUsageSnapshot {
  const b = (body ?? {}) as Record<string, unknown>;
  const metrics: PlanMetric[] = [];
  const consumedKeys = new Set<string>();

  const consume = (key: string): void => {
    consumedKeys.add(key);
  };

  const fiveKey = "five_hour" in b ? "five_hour" : "fiveHour" in b ? "fiveHour" : null;
  if (fiveKey) {
    const five = pluckBucket(b[fiveKey]);
    if (five) {
      metrics.push({
        key: "fiveHour",
        label: "5h session",
        percentUsed: five.percentUsed,
        resetAt: five.resetAt,
        detail: five.detail,
      });
    }
    consume(fiveKey);
  }

  const sevenKey = "seven_day" in b ? "seven_day" : "sevenDay" in b ? "sevenDay" : null;
  if (sevenKey) {
    const seven = pluckBucket(b[sevenKey]);
    if (seven) {
      metrics.push({
        key: "sevenDay",
        label: "7d all models",
        percentUsed: seven.percentUsed,
        resetAt: seven.resetAt,
        detail: seven.detail,
      });
    }
    consume(sevenKey);
  }

  const extraKey = "extra_usage" in b ? "extra_usage" : "extraUsage" in b ? "extraUsage" : null;
  if (extraKey) {
    const extra = b[extraKey] as Record<string, unknown> | null;
    if (extra && typeof extra === "object") {
      const enabled = Boolean(extra.is_enabled ?? extra.enabled);
      const used = typeof extra.used_credits === "number" ? extra.used_credits : 0;
      const limit =
        typeof extra.monthly_limit === "number"
          ? extra.monthly_limit
          : typeof extra.monthlyLimit === "number"
            ? (extra.monthlyLimit as number)
            : 0;
      const pct = pickPercent(extra.utilization) ?? (limit > 0 ? (used / limit) * 100 : 0);
      metrics.push({
        key: "extraUsage",
        label: "extra credits",
        percentUsed: pct,
        resetAt: null,
        detail: enabled ? `$${used.toFixed(0)}/$${limit}` : "off",
      });
    }
    consume(extraKey);
  }

  // Generic weekly bucket pass. Any unconsumed top-level key that
  // either *contains* `weekly` (e.g. `weekly_claude_design`) or is a
  // `seven_day_*` sibling of the plain seven-day bucket, and parses as
  // a bucket, gets surfaced as a metric with the same `weeklyOther`
  // key. The label is the raw key name, lightly humanised, so the user
  // can recognise which bucket they're looking at on the Stream Deck
  // cycle.
  //
  // The `seven_day_*` half matters: per-model weekly limits arrive as
  // siblings of `seven_day` rather than under any `weekly` name.
  // Observed live on a real account: `seven_day_opus`,
  // `seven_day_sonnet`, `seven_day_oauth_apps`, `seven_day_cowork`.
  // Matching only on `weekly` dropped every one of them silently —
  // the Stream Deck showed an all-models figure while the per-model
  // meter that actually gates you went unseen.
  //
  // Once the actual Claude Design key name is confirmed in
  // daemon.log (`plan response shape: keys=[…]`), it gets promoted
  // to a first-class explicit bucket with a curated label.
  for (const [key, value] of Object.entries(b)) {
    if (consumedKeys.has(key)) continue;
    if (!/weekly/i.test(key) && !/^seven[_-]?day[_-]./i.test(key)) continue;
    const bucket = pluckBucket(value);
    if (!bucket) continue;
    metrics.push({
      key: "weeklyOther",
      label: humaniseKey(key),
      percentUsed: bucket.percentUsed,
      resetAt: bucket.resetAt,
      detail: bucket.detail,
    });
  }

  return { metrics, fetchedAt };
}

/**
 * Turn `weekly_claude_design` into `Weekly Claude Design`. Best-
 * effort — the goal is something readable on a Stream Deck cycle,
 * not a perfect title-cased label.
 */
function humaniseKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function pickPercent(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const candidate =
      v.percentage ??
      v.percent ??
      v.usage ??
      v.utilization ??
      v.used_percentage ??
      v.usedPercentage;
    if (typeof candidate === "number") return candidate;
  }
  return undefined;
}

function pluckBucket(
  raw: unknown,
): { percentUsed: number; resetAt: number | null; detail?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pct = pickPercent(r.utilization) ?? pickPercent(r.percentage) ?? pickPercent(r.percent);
  if (pct === undefined) return null;
  const resetIso =
    (typeof r.resets_at === "string" && r.resets_at) ||
    (typeof r.resetsAt === "string" && r.resetsAt) ||
    (typeof r.reset_at === "string" && r.reset_at) ||
    (typeof r.expires_at === "string" && r.expires_at) ||
    null;
  const resetAt = resetIso ? Date.parse(resetIso) : null;
  return {
    percentUsed: pct,
    resetAt: resetAt !== null && Number.isNaN(resetAt) ? null : resetAt,
    detail: resetIso ? `resets ${shortTime(resetIso)}` : undefined,
  };
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Legacy default export — lets older call sites still just `fetcher()`. */
export const claudeAiFetcher: PlanFetcher = async () => {
  const fetcher = makeClaudeAiFetcher();
  return fetcher();
};
