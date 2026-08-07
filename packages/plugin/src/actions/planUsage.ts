import type { PlanMetric, PlanMetricKey } from "../wire";
import { thresholdColor } from "./threshold";

export interface PlanUsageRender {
  /**
   * SDK title is intentionally always empty. The whole visual lives
   * in the SVG returned by `renderPlanUsageImage` so the layout
   * (name top, donut center, detail bottom) doesn't depend on any
   * per-key TitleAlignment override the user may have cached when
   * first placing the action on a button. Same trick that worked
   * for `renderAgentSlot` after claudedeck's layout overhaul.
   */
  title: string;
  /** Human label drawn at the top of the key image. */
  displayName: string;
  /** Threshold color for the donut arc, or `undefined` for non-donut states. */
  fillColor?: string;
  /** 0-100 integer for the donut arc and centre text. `undefined` for non-donut states. */
  percentUsed?: number;
  /** Optional bottom-right caption (e.g. "46m left", "$10/$40"). */
  detail?: string;
  /** Background color for the key image. Threshold colors signal urgency. */
  backgroundHex: string;
  /** Error reason — drives the alert visual + helps the user understand stale data. */
  errorText?: string;
  warn: boolean; // 50% ≤ p < 80%
  alert: boolean; // p ≥ 80% OR lastError present
}

const BACKGROUND_NORMAL = "#1e1e2e"; // base
const BACKGROUND_ERROR = "#742a2a"; // dim red — matches agent-slot's `blocked` urgency register
const BACKGROUND_PLACEHOLDER = "#1c1f26"; // empty-slot color so the key reads as "no data"
const NAME_MAX_CHARS = 10;
const DETAIL_MAX_CHARS = 10;

/**
 * Pure render fn. Consumes the most recent `PlanUsageSnapshot.metrics`
 * plus the UI's currently-selected mode (which key of PlanMetricKey
 * the user is cycled to), and the last error (if any). Returns the
 * render struct the SDK adapter passes to `setTitle("")` +
 * `setImage(renderPlanUsageImage(render))`.
 *
 * Three display modes:
 *
 *   - Healthy:  donut + center % + small detail line at bottom.
 *   - Error:    red background + "error" label + truncated reason.
 *               No donut (no number to show).
 *   - Placeholder: dim background + "plan / USE" label. No donut.
 *
 * Ported unchanged from claudedeck — `plan:update` / `PlanUsageSnapshot`
 * are copied verbatim per docs/CONTRACTS.md.
 */
export function renderPlanUsage(
  metrics: PlanMetric[],
  currentMode: PlanMetricKey,
  lastError: string | undefined,
): PlanUsageRender {
  if (metrics.length === 0) {
    if (lastError) {
      return {
        title: "",
        displayName: "error",
        errorText: truncate(lastError, 18),
        backgroundHex: BACKGROUND_ERROR,
        warn: false,
        alert: true,
      };
    }
    return {
      title: "",
      displayName: "plan",
      detail: "USE",
      backgroundHex: BACKGROUND_PLACEHOLDER,
      warn: false,
      alert: false,
    };
  }

  const metric = metrics.find((m) => m.key === currentMode) ?? metrics[0];
  if (!metric) {
    return {
      title: "",
      displayName: "plan",
      detail: "USE",
      backgroundHex: BACKGROUND_PLACEHOLDER,
      warn: false,
      alert: false,
    };
  }

  const pct = Math.max(0, Math.round(metric.percentUsed));
  return {
    title: "",
    displayName: truncate(metric.label, NAME_MAX_CHARS),
    percentUsed: pct,
    fillColor: thresholdColor(pct),
    detail: metric.detail ? truncate(metric.detail, DETAIL_MAX_CHARS) : undefined,
    backgroundHex: BACKGROUND_NORMAL,
    warn: pct >= 50 && pct < 80,
    alert: pct >= 80,
  };
}

/**
 * SVG data URL for the Stream Deck SDK's `setImage`. Mirrors
 * `renderAgentSlotImage`'s coordinate system 1:1 — name at y=14,
 * donut at (36, 44) r=18, percent text centred in the donut, optional
 * detail at y=68. Two keys, one visual language.
 *
 * Error / placeholder variants omit the donut and lean on the
 * background color + label to signal what's going on.
 */
export function renderPlanUsageImage(render: {
  backgroundHex: string;
  displayName: string;
  percentUsed?: number;
  fillColor?: string;
  detail?: string;
  errorText?: string;
}): string {
  const nameOverlay = `<text x="36" y="14" font-family="-apple-system, sans-serif" font-size="11" font-weight="600" fill="#fff" text-anchor="middle">${escapeForSvg(render.displayName)}</text>`;

  // Donut block: track + progress arc + centre %. Same math as
  // agentSlot: 2πr circumference, stroke-dashoffset proportional
  // to (1 - percent/100), -90° rotation so the arc starts at 12 o'clock.
  let donut = "";
  if (typeof render.percentUsed === "number" && render.fillColor) {
    const cx = 36;
    const cy = 44;
    const r = 18;
    const circumference = 2 * Math.PI * r;
    const visibleFraction = Math.max(0, Math.min(100, render.percentUsed)) / 100;
    const dashoffset = (circumference * (1 - visibleFraction)).toFixed(2);
    const dasharray = circumference.toFixed(2);
    const arc =
      render.percentUsed > 0
        ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${render.fillColor}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${dasharray}" stroke-dashoffset="${dashoffset}" transform="rotate(-90 ${cx} ${cy})"/>`
        : "";
    donut =
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="6"/>${arc}` +
      `<text x="${cx}" y="${cy + 5}" font-family="-apple-system, sans-serif" font-size="16" font-weight="bold" fill="#fff" text-anchor="middle">${render.percentUsed}%</text>`;
  }

  // Error variant: prominent reason text in the centre instead of
  // the donut. Two lines: "error" at the top is the displayName
  // overlay above; the detail line goes here.
  let errorBlock = "";
  if (render.errorText) {
    errorBlock = `<text x="36" y="42" font-family="-apple-system, sans-serif" font-size="9" font-weight="500" fill="#fff" text-anchor="middle">${escapeForSvg(render.errorText)}</text>`;
  }

  // Bottom detail caption — small, dim, hidden when not provided.
  let detailLine = "";
  if (render.detail) {
    // Slightly off-centre vertical so it doesn't crowd the donut's
    // bottom edge (donut spans y=26..62). y=70 sits in the last 2px
    // of the 72px button, dim text keeps it out of the eye-line
    // unless the user looks for it.
    detailLine = `<text x="36" y="69" font-family="-apple-system, sans-serif" font-size="9" fill="#cdd6f4" fill-opacity="0.75" text-anchor="middle">${escapeForSvg(render.detail)}</text>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" fill="${render.backgroundHex}"/>${nameOverlay}${donut}${errorBlock}${detailLine}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Move to the next metric key. Wraps at the end; unknown current falls
 * back to the first. Empty list is a no-op (returns input).
 */
export function cyclePlanMode(
  keys: readonly PlanMetricKey[],
  current: PlanMetricKey,
): PlanMetricKey {
  if (keys.length === 0) return current;
  const idx = keys.indexOf(current);
  if (idx < 0) return keys[0] as PlanMetricKey;
  return keys[(idx + 1) % keys.length] as PlanMetricKey;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

function escapeForSvg(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
