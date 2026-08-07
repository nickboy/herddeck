import {
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  action,
} from "@elgato/streamdeck";
import type { AgentSlotManager } from "../agentSlots";
import type { TargetSnapshot } from "../wire";

export interface TargetSwitcherRender {
  title: string;
}

const ALL_LABEL = "ALL";
const TITLE_MAX_CHARS = 10; // mirrors agentSlot's TITLE_MAX_CHARS

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/** Pure render fn. `null` filter (no target selected) shows the ALL sentinel. */
export function renderTargetSwitcher(filter: string | null): TargetSwitcherRender {
  return { title: filter === null ? ALL_LABEL : truncate(filter, TITLE_MAX_CHARS) };
}

/**
 * Pure policy for "what's the next filter after a press?" Cycles
 * `null` ("all") → `targetNames[0]` → `targetNames[1]` → … → `null`,
 * wrapping. `current` values no longer present in `targetNames` (e.g.
 * a remote target dropped from config) are treated the same as "not
 * found" and advance to the first target, same as claudedeck's
 * `cyclePlanMode` unknown-current fallback.
 */
export function cycleTargetFilter(
  current: string | null,
  targetNames: readonly string[],
): string | null {
  if (targetNames.length === 0) return null;
  if (current === null) return targetNames[0] ?? null;
  const idx = targetNames.indexOf(current);
  if (idx === -1) return targetNames[0] ?? null; // unknown current → first target
  if (idx === targetNames.length - 1) return null; // wrap to "all"
  return targetNames[idx + 1] ?? null;
}

/* ----------------------------------------------------------------------
 * SDK adapter
 *
 * Only meaningful with >1 configured target — AgentSlotManager's
 * filter exists so a busy multi-target deck can narrow the slot row
 * to one target at a time. With a single target there's nothing to
 * cycle to, so `onKeyDown` is a deliberate no-op (not even a repaint).
 * -------------------------------------------------------------------- */

export interface TargetSwitcherActionDeps {
  manager: AgentSlotManager;
  /** Latest `targets:update` snapshot — read live, not captured at construction. */
  getTargets: () => readonly TargetSnapshot[];
  /**
   * Called after the filter changes so the caller can repaint the
   * agent slot row + menu (both page over the now-filtered set).
   */
  onFilterChanged?: () => void | Promise<void>;
}

@action({ UUID: "com.nickboy.herddeck.target-switcher" })
export class TargetSwitcherAction extends SingletonAction {
  constructor(private readonly deps: TargetSwitcherActionDeps) {
    super();
  }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const render = renderTargetSwitcher(this.deps.manager.targetFilter());
    await ev.action.setTitle(render.title);
  }

  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    const names = this.deps.getTargets().map((t) => t.name);
    if (names.length <= 1) return; // nothing meaningful to switch between
    const next = cycleTargetFilter(this.deps.manager.targetFilter(), names);
    this.deps.manager.setTargetFilter(next);
    await this.repaint();
    await this.deps.onFilterChanged?.();
  }

  async repaint(): Promise<void> {
    const render = renderTargetSwitcher(this.deps.manager.targetFilter());
    for (const visible of this.actions) await visible.setTitle(render.title);
  }
}
