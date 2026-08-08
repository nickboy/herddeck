import {
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  action,
} from "@elgato/streamdeck";
import { type AgentSlotManager, slotFromCoordinates } from "../agentSlots";
import type { BridgeClient } from "../bridgeClient";
import type { AgentSnapshot, AgentStatus } from "../wire";
import { thresholdColor } from "./threshold";

export interface AgentSlotRender {
  /**
   * Always empty for active agent slots — we draw the name in the
   * SVG ourselves so the layout (name top, donut middle) survives
   * regardless of any per-key TitleAlignment override the user
   * created when first dragging the action onto a button. Same
   * trick claudedeck's `sessionSlot.ts` used, ported unchanged.
   *
   * Empty slots still use the SDK title path (the manifest default
   * is fine when we have nothing to draw on top of state color).
   */
  title: string;
  /** The name to render inside the SVG, with focus marker if any. */
  displayName?: string;
  /** Small target-name suffix, only set when more than one target is configured. */
  targetSuffix?: string;
  backgroundHex: string;
  dim: boolean;
  pulse: boolean;
  contextFillPercent?: number;
  contextFillColor?: string;
}

/**
 * Status → colour mapping (Catppuccin Mocha), per docs/CONTRACTS.md.
 * Public for test readability, mirrors claudedeck's STATE_COLOURS.
 */
export const STATUS_COLOURS: Record<AgentStatus, string> = {
  blocked: "#f38ba8",
  working: "#f9e2af",
  done: "#a6e3a1",
  idle: "#6c7086",
  unknown: "#6c7086",
  offline: "#45475a",
};

/** Empty-slot background. Distinct so the key reads as "no agent here". */
export const EMPTY_SLOT_BG = "#1c1f26";

/** Key label truncation budget when no context % is shown. */
const TITLE_MAX_CHARS = 10;

/**
 * Tighter truncation when we add a second-line `XX%`. Keeps both
 * lines from spilling into each other on the 72×72 surface.
 */
const TITLE_MAX_CHARS_WITH_CONTEXT = 8;

const TARGET_SUFFIX_MAX_CHARS = 8;

/**
 * Pure function mapping an agent snapshot (possibly undefined — empty
 * slot), whether it's the currently-focused agent, and whether more
 * than one target is configured, to what the Stream Deck key should
 * display. Tested in isolation; the SDK adapter below is a thin
 * wrapper that calls `setTitle` + `setImage`.
 */
export function renderAgentSlot(
  agent: AgentSnapshot | undefined,
  focused: boolean,
  multiTarget: boolean,
): AgentSlotRender {
  if (!agent) {
    return {
      title: "",
      backgroundHex: EMPTY_SLOT_BG,
      dim: true,
      pulse: false,
    };
  }

  const ctx = agent.ctxPct ?? undefined;
  const charBudget = ctx !== undefined ? TITLE_MAX_CHARS_WITH_CONTEXT : TITLE_MAX_CHARS;
  // Title priority: herdr agent name, then the tab label, then the
  // workspace label, then the cwd basename — see docs/CONTRACTS.md
  // "Slot title".
  const base =
    // terminal title first: Claude Code re-emits it via OSC on /rename,
    // so it tracks the session name live, while a tab label is frozen at
    // session start (no rename hook exists to refresh it).
    agent.name ||
    agent.title ||
    agent.tabLabel ||
    agent.workspaceLabel ||
    basename(agent.cwd ?? "") ||
    "";
  const truncated = truncate(base, charBudget);
  const displayName = focused ? `▸ ${truncated}` : truncated;

  return {
    // Empty SDK title — see AgentSlotRender comment. We draw
    // displayName in the SVG instead so it lands at y=12 regardless
    // of any per-key TitleAlignment cached by the Stream Deck app.
    title: "",
    displayName,
    targetSuffix: multiTarget ? truncate(agent.target, TARGET_SUFFIX_MAX_CHARS) : undefined,
    backgroundHex: STATUS_COLOURS[agent.status],
    dim: false,
    pulse: agent.status === "blocked",
    contextFillPercent: ctx !== undefined ? Math.round(ctx) : undefined,
    contextFillColor: ctx !== undefined ? thresholdColor(ctx) : undefined,
  };
}

function basename(p: string): string {
  if (!p) return "";
  // Strip trailing slashes, then take everything after the last slash.
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * SVG data URL for the Stream Deck SDK's `setImage`. Empty slots get
 * the static `>_` placeholder; active slots get a solid state-color
 * swatch so the physical key is visually coded `blocked` / `working`
 * / `done` / `idle` / `unknown` / `offline` at a glance. Title text
 * (set separately via `setTitle`) renders on top of this image.
 */
export function renderAgentSlotImage(render: {
  backgroundHex: string;
  dim: boolean;
  displayName?: string;
  targetSuffix?: string;
  contextFillPercent?: number;
  contextFillColor?: string;
}): string {
  const iconOverlay = render.dim
    ? `<rect x="12" y="20" width="48" height="32" rx="4" fill="none" stroke="#89b4fa" stroke-width="2"/><text x="36" y="42" font-family="monospace" font-size="14" font-weight="bold" fill="#89b4fa" text-anchor="middle">&gt;_</text>`
    : "";

  // Agent name at the very top of the button — drawn in SVG (not via
  // the SDK title) so its alignment isn't subject to any per-key
  // TitleAlignment override the user set when first placing the
  // action. With Stream Deck tilted, the top-row pixels are the
  // most readable spot. y=14 lands the text baseline well into the
  // top edge while leaving a tiny breathing margin.
  const nameOverlay =
    !render.dim && render.displayName
      ? `<text x="36" y="14" font-family="-apple-system, sans-serif" font-size="11" font-weight="600" fill="#fff" text-anchor="middle">${escapeForSvg(render.displayName)}</text>`
      : "";

  // Small target-name suffix, only present with >1 configured
  // target — sits just below the name, dim, so a single-target setup
  // (the common case) keeps the uncluttered claudedeck look.
  const targetOverlay =
    !render.dim && render.targetSuffix
      ? `<text x="36" y="23" font-family="-apple-system, sans-serif" font-size="7" fill="#cdd6f4" fill-opacity="0.75" text-anchor="middle">${escapeForSvg(render.targetSuffix)}</text>`
      : "";

  // Donut ring reflecting context-window % when known. Visual
  // language matches the Plan Usage key (which uses the same arc).
  // Centered at (36, 44) — vertically positioned so the ring sits
  // BELOW the y=14 name and a touch above the bottom edge, since
  // the user reads the deck at a tilt and the bottom rows are the
  // hardest pixels to see. Big % text in the donut centre carries
  // the number so the user sees it at a glance.
  //
  // The arc is a stroked circle with stroke-dasharray set to the
  // circumference and stroke-dashoffset sized so the visible portion
  // matches the percent. transform="rotate(-90)" puts the start at
  // 12 o'clock instead of 3.
  let donut = "";
  if (!render.dim && typeof render.contextFillPercent === "number" && render.contextFillColor) {
    const cx = 36;
    const cy = 44;
    const r = 18;
    const circumference = 2 * Math.PI * r; // ~113.10
    const visibleFraction = Math.max(0, Math.min(100, render.contextFillPercent)) / 100;
    const dashoffset = (circumference * (1 - visibleFraction)).toFixed(2);
    const dasharray = circumference.toFixed(2);
    const arc =
      render.contextFillPercent > 0
        ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${render.contextFillColor}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${dasharray}" stroke-dashoffset="${dashoffset}" transform="rotate(-90 ${cx} ${cy})"/>`
        : "";
    donut =
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="6"/>${arc}` +
      `<text x="${cx}" y="${cy + 5}" font-family="-apple-system, sans-serif" font-size="16" font-weight="bold" fill="#fff" text-anchor="middle">${render.contextFillPercent}%</text>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" fill="${render.backgroundHex}"/>${iconOverlay}${donut}${nameOverlay}${targetOverlay}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// XML-escape agent names / cwd basenames that might contain
// `<`/`>`/`&` so the SVG stays valid — these are user-controlled
// project folder / herdr agent names, so we can't trust them blindly.
function escapeForSvg(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* ----------------------------------------------------------------------
 * SDK adapter
 *
 * Mirrors claudedeck's SessionSlotAction: thin class wrapping the
 * pure `renderAgentSlot` above. Not directly unit-tested — the
 * behaviour that matters is in renderAgentSlot and in
 * AgentSlotManager, both of which have their own tests.
 * -------------------------------------------------------------------- */

export interface AgentSlotActionDeps {
  bridge: BridgeClient;
  manager: AgentSlotManager;
  /** True once more than one target is configured — drives the small target-name suffix. */
  isMultiTarget: () => boolean;
  /**
   * Optional resolver from a Stream Deck action context id to the
   * 0-indexed slot it occupies on the MK.2. Defaults to the
   * coordinate-based helper (`slotFromCoordinates`) applied on each
   * event's `action.coordinates`. Override for tests or custom
   * layouts.
   */
  slotForAction?: (actionId: string) => number | undefined;
}

type CoordAction = { action: { id: string; coordinates?: { column: number; row: number } } };

/**
 * Stream Deck action class for a single herdr agent slot. UUID
 * `com.nickboy.herddeck.agent-slot`. Thin adapter — render logic is
 * in `renderAgentSlot`, state in `AgentSlotManager`.
 */
@action({ UUID: "com.nickboy.herddeck.agent-slot" })
export class AgentSlotAction extends SingletonAction {
  constructor(private readonly deps: AgentSlotActionDeps) {
    super();
  }

  private slotFor(ev: CoordAction): number | undefined {
    if (this.deps.slotForAction) return this.deps.slotForAction(ev.action.id);
    return slotFromCoordinates(ev.action.coordinates);
  }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const slot = this.slotFor(ev as unknown as CoordAction);
    if (slot === undefined) {
      const render = renderAgentSlot(undefined, false, false);
      await ev.action.setTitle(render.title);
      return;
    }
    const agent = this.deps.manager.agentAt(slot);
    const focused = agent ? this.deps.manager.isFocused(agent) : false;
    const render = renderAgentSlot(agent, focused, this.deps.isMultiTarget());
    await ev.action.setTitle(render.title);
    await (ev.action as { setImage: (url: string) => Promise<void> }).setImage(
      renderAgentSlotImage(render),
    );
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const slot = this.slotFor(ev as unknown as CoordAction);
    if (slot === undefined) return;
    const agent = this.deps.manager.agentAt(slot);
    if (!agent) return;
    this.deps.manager.setFocused({ target: agent.target, paneId: agent.paneId });
    // Single command handles both focus tracking AND foregrounding the
    // terminal app (daemon-side) — v2 unifies claudedeck's
    // session:focus + session:jump pair. Plugin does no AppleScript.
    this.deps.bridge.send({ type: "agent:focus", target: agent.target, paneId: agent.paneId });
  }
}
