/**
 * `weeklyOther` is a catch-all for any weekly bucket Anthropic
 * surfaces that we haven't explicitly mapped yet (e.g. Claude
 * Design's weekly limit, which we only learned about post-PR #49).
 * Surfaced via the generic pass in `claudeAiFetcher.ts`. Once a
 * specific bucket has been observed and named in production logs
 * it gets promoted to a first-class key here.
 */
export type PlanMetricKey = "fiveHour" | "sevenDay" | "extraUsage" | "weeklyOther";

export interface PlanMetric {
  key: PlanMetricKey;
  /** Human label, e.g. "5h session". */
  label: string;
  /** 0–100. */
  percentUsed: number;
  /** Unix ms when the allowance resets, or null if not applicable. */
  resetAt: number | null;
  detail?: string;
}

export interface PlanUsageSnapshot {
  metrics: PlanMetric[];
  fetchedAt: number;
}
