import { describe, expect, test } from "bun:test";
import {
  type CredentialsReader,
  type HttpFetch,
  formatHttpError,
  loadAccessToken,
  makeClaudeAiFetcher,
  parsePlanUsageResponse,
} from "./claudeAiFetcher";

const okCreds: CredentialsReader = async () => ({
  stdout: JSON.stringify({ claudeAiOauth: { accessToken: "tok-abc", expiresAt: 99999 } }),
  stderr: "",
  exitCode: 0,
});

const missingCreds: CredentialsReader = async () => ({
  stdout: "",
  stderr: "password not found",
  exitCode: 44,
});

const goodResponseJson = {
  five_hour: { utilization: 14, resets_at: "2026-04-19T17:00:00Z" },
  seven_day: { utilization: 32, resets_at: "2026-04-26T00:00:00Z" },
  extra_usage: { is_enabled: true, monthly_limit: 60, used_credits: 12, utilization: 20 },
};

const makeHttp =
  (body: unknown, status = 200): HttpFetch =>
  async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("loadAccessToken", () => {
  test("reads token from JSON blob under claudeAiOauth.accessToken", async () => {
    const out = await loadAccessToken(okCreds);
    expect(out).toEqual({ accessToken: "tok-abc", expiresAt: 99999 });
  });

  test("tolerates snake_case field names", async () => {
    const snake: CredentialsReader = async () => ({
      stdout: JSON.stringify({ claudeAiOauth: { access_token: "xyz", expires_at: 111 } }),
      stderr: "",
      exitCode: 0,
    });
    expect(await loadAccessToken(snake)).toEqual({ accessToken: "xyz", expiresAt: 111 });
  });

  test("reports 'not in keychain' on non-zero exit", async () => {
    const out = await loadAccessToken(missingCreds);
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toContain("Keychain");
  });

  test("reports parse error on non-JSON", async () => {
    const reader: CredentialsReader = async () => ({ stdout: "not json", stderr: "", exitCode: 0 });
    expect(await loadAccessToken(reader)).toEqual({ error: "keychain entry is not JSON" });
  });

  test("reports missing accessToken when blob lacks the field", async () => {
    const reader: CredentialsReader = async () => ({
      stdout: JSON.stringify({ claudeAiOauth: {} }),
      stderr: "",
      exitCode: 0,
    });
    expect(await loadAccessToken(reader)).toEqual({ error: "credentials missing accessToken" });
  });
});

describe("parsePlanUsageResponse", () => {
  test("extracts five_hour, seven_day, extra_usage into three metrics", () => {
    const snap = parsePlanUsageResponse(goodResponseJson, 2_000_000);
    expect(snap.fetchedAt).toBe(2_000_000);
    expect(snap.metrics.map((m) => m.key).sort()).toEqual(["extraUsage", "fiveHour", "sevenDay"]);
    const five = snap.metrics.find((m) => m.key === "fiveHour");
    expect(five?.percentUsed).toBe(14);
    expect(five?.detail).toContain("resets");
  });

  test("handles camelCase variants (fiveHour / sevenDay)", () => {
    const snap = parsePlanUsageResponse(
      { fiveHour: { percentage: 7, resetsAt: "2026-04-19T10:00:00Z" } },
      1,
    );
    expect(snap.metrics).toHaveLength(1);
    expect(snap.metrics[0]?.percentUsed).toBe(7);
  });

  test("drops buckets that lack any percent-like field", () => {
    const snap = parsePlanUsageResponse({ five_hour: { something: "else" } }, 1);
    expect(snap.metrics).toHaveLength(0);
  });

  test("extraUsage detail shows $used/$limit when enabled", () => {
    const snap = parsePlanUsageResponse(
      { extra_usage: { is_enabled: true, monthly_limit: 40, used_credits: 10 } },
      1,
    );
    const extra = snap.metrics.find((m) => m.key === "extraUsage");
    expect(extra?.detail).toContain("$10");
    expect(extra?.detail).toContain("$40");
  });

  test("extraUsage disabled shows 'off'", () => {
    const snap = parsePlanUsageResponse(
      { extra_usage: { is_enabled: false, monthly_limit: 40, used_credits: 0 } },
      1,
    );
    expect(snap.metrics.find((m) => m.key === "extraUsage")?.detail).toBe("off");
  });

  test("generic weekly buckets are surfaced via the heuristic pass", () => {
    // "weekly_claude_design" — the bucket Anthropic added recently
    // and which we hadn't mapped explicitly. Heuristic catches any
    // key matching /weekly/i with a parseable utilization payload.
    const snap = parsePlanUsageResponse(
      {
        five_hour: { utilization: 10 },
        weekly_claude_design: { utilization: 51, resets_at: "2026-05-17T00:00:00Z" },
        weekly_sonnet_only: { utilization: 30 },
      },
      1,
    );
    const weekly = snap.metrics.filter((m) => m.key === "weeklyOther");
    expect(weekly).toHaveLength(2);
    // Labels are humanised from the raw key name.
    expect(weekly.map((m) => m.label).sort()).toEqual([
      "Weekly Claude Design",
      "Weekly Sonnet Only",
    ]);
    expect(weekly.find((m) => m.label === "Weekly Claude Design")?.percentUsed).toBe(51);
  });

  test("heuristic does NOT double-count keys already consumed by explicit handlers", () => {
    // A future-proof: if Anthropic renames seven_day to something
    // like seven_day_weekly we'd want to keep the explicit handler,
    // not pick the same bucket up twice via the heuristic. Verify
    // the explicit path's consumedKeys gate works.
    const snap = parsePlanUsageResponse(
      {
        seven_day: { utilization: 22 },
        weekly_design: { utilization: 51 },
      },
      1,
    );
    expect(snap.metrics.find((m) => m.key === "sevenDay")?.percentUsed).toBe(22);
    const weekly = snap.metrics.filter((m) => m.key === "weeklyOther");
    expect(weekly).toHaveLength(1);
    expect(weekly[0]?.label).toBe("Weekly Design");
  });

  test("heuristic skips weekly-named keys whose value isn't a parseable bucket", () => {
    const snap = parsePlanUsageResponse(
      {
        weekly_meta: "this isn't a bucket", // not an object → skip
        weekly_no_utilization: { foo: "bar" }, // no usable percent → skip
      },
      1,
    );
    expect(snap.metrics.filter((m) => m.key === "weeklyOther")).toHaveLength(0);
  });
});

describe("makeClaudeAiFetcher integration", () => {
  test("returns PlanUsageSnapshot on happy path with bearer token + beta header", async () => {
    let captured: Record<string, string> | undefined;
    const httpFetch: HttpFetch = async (_url, init) => {
      captured = init?.headers as Record<string, string>;
      return new Response(JSON.stringify(goodResponseJson), { status: 200 });
    };
    const fetcher = makeClaudeAiFetcher({
      url: "http://unused",
      httpFetch,
      readCredentials: okCreds,
      clock: () => 55,
    });
    const out = await fetcher();
    expect("metrics" in out).toBe(true);
    if ("metrics" in out) {
      expect(out.fetchedAt).toBe(55);
      expect(out.metrics).toHaveLength(3);
    }
    expect(captured?.Authorization).toBe("Bearer tok-abc");
    expect(captured?.["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  test("returns error when keychain is empty", async () => {
    const fetcher = makeClaudeAiFetcher({
      url: "http://unused",
      httpFetch: makeHttp({}),
      readCredentials: missingCreds,
    });
    expect("error" in (await fetcher())).toBe(true);
  });

  test("returns error on 401", async () => {
    const fetcher = makeClaudeAiFetcher({
      url: "http://unused",
      httpFetch: makeHttp("unauthorized", 401),
      readCredentials: okCreds,
    });
    const out = await fetcher();
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toContain("expired or invalid");
  });

  test("returns error on 500", async () => {
    const fetcher = makeClaudeAiFetcher({
      url: "http://unused",
      httpFetch: makeHttp("boom", 500),
      readCredentials: okCreds,
    });
    const out = await fetcher();
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toContain("HTTP 500");
  });

  test("returns error on non-JSON body", async () => {
    const fetcher = makeClaudeAiFetcher({
      url: "http://unused",
      httpFetch: async () => new Response("not json", { status: 200 }),
      readCredentials: okCreds,
    });
    const out = await fetcher();
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toContain("non-JSON");
  });

  test("network failure becomes a clean error string", async () => {
    const fetcher = makeClaudeAiFetcher({
      url: "http://unused",
      httpFetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      readCredentials: okCreds,
    });
    const out = await fetcher();
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toContain("ECONNREFUSED");
  });
});

describe("formatHttpError", () => {
  test("status only when no header or body", async () => {
    const res = new Response("", { status: 500 });
    const msg = await formatHttpError(res);
    expect(msg).toBe("HTTP 500 body=<empty>");
  });

  test("includes Retry-After header value when present", async () => {
    const res = new Response('{"error":"rate limited"}', {
      status: 429,
      headers: { "retry-after": "272", "content-type": "application/json" },
    });
    const msg = await formatHttpError(res);
    expect(msg).toContain("HTTP 429");
    expect(msg).toContain("retry-after=272");
    expect(msg).toContain('body={"error":"rate limited"}');
  });

  test("truncates long body to ~180 chars + ellipsis", async () => {
    const huge = "x".repeat(500);
    const res = new Response(huge, { status: 500 });
    const msg = await formatHttpError(res);
    expect(msg).toContain("HTTP 500");
    // Body section should be capped — 180 + 3-char ellipsis.
    const bodyMatch = msg.match(/body=(.*)$/);
    expect(bodyMatch).not.toBeNull();
    if (bodyMatch) expect(bodyMatch[1]?.length ?? 0).toBeLessThanOrEqual(200);
    expect(msg).toContain("...");
  });

  test("fetcher surfaces the rich error string on 429", async () => {
    const fetcher = makeClaudeAiFetcher({
      url: "http://unused",
      httpFetch: async () =>
        new Response('{"error":{"type":"rate_limit_error","message":"Rate limited."}}', {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      readCredentials: okCreds,
    });
    const out = await fetcher();
    expect("error" in out).toBe(true);
    if ("error" in out) {
      expect(out.error).toContain("HTTP 429");
      expect(out.error).toContain("retry-after=120");
      expect(out.error).toContain("rate_limit_error");
    }
  });
});
