/**
 * Catppuccin Mocha threshold colors. Shared between any action that
 * visualises a percent metric — currently the agent slot's
 * context-window donut and the Plan Usage key's per-bucket donut.
 * Ported unchanged from claudedeck's `plugin/src/actions/threshold.ts`.
 *
 * Buckets:
 *   <50%   green    healthy
 *   50–79% yellow   warming, plan ahead
 *   ≥80%   red      take action (/compact, wait for reset, etc.)
 *
 * Exported as both colors and breakpoints so tests can assert
 * threshold-crossing behaviour without depending on the literal
 * hex string.
 */

export const THRESHOLD_GREEN = "#94e2d5";
export const THRESHOLD_YELLOW = "#f9e2af";
export const THRESHOLD_RED = "#f38ba8";

export const WARN_AT = 50;
export const ALERT_AT = 80;

/**
 * Pick the threshold colour for a percentage. Single source of
 * truth — keeps the agent-slot donut and the Plan Usage donut in
 * sync. Inputs outside [0, 100] are clamped before bucketing.
 */
export function thresholdColor(percent: number): string {
  const p = Math.max(0, Math.min(100, percent));
  if (p >= ALERT_AT) return THRESHOLD_RED;
  if (p >= WARN_AT) return THRESHOLD_YELLOW;
  return THRESHOLD_GREEN;
}
