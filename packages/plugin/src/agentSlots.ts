import { EventEmitter } from "node:events";
import type { AgentSnapshot } from "./wire";

/** MK.2 has one row of 5 slot keys (columns 0-4), same layout claudedeck settled on. */
export const DEFAULT_MAX_SLOTS = 5;

export interface AgentSlotManagerOptions {
  /** Override cap (defaults to DEFAULT_MAX_SLOTS, currently 5). */
  maxSlots?: number;
}

export interface AgentKey {
  target: string;
  paneId: string;
}

export function sameAgent(a: AgentKey | undefined, b: AgentKey | undefined): boolean {
  if (!a || !b) return false;
  return a.target === b.target && a.paneId === b.paneId;
}

/**
 * Holds the daemon's full, already-ordered agent list plus local
 * UI-only state: which page of slots is showing, and which agent is
 * "focused" (the answer/arrow-key row acts on the focused agent).
 *
 * Unlike claudedeck's `SessionSlotManager`, there is no per-agent
 * upsert/remove/LRU-eviction: the daemon pushes the FULL agent list
 * on every `agents:update` (see docs/CONTRACTS.md), so `setAgents`
 * just replaces the list wholesale and ordering is never touched
 * here beyond stable pagination — the daemon owns sort order.
 *
 * Paging (absent from claudedeck, which instead capped at
 * MAX_SESSIONS with LRU eviction) exists because a herdr session can
 * have more live agents than fit in one MK.2 row: the MENU key
 * cycles pages when `agents.length > maxSlots` (docs/CONTRACTS.md:
 * "menu (paging)").
 */
export class AgentSlotManager extends EventEmitter {
  private agentsList: readonly AgentSnapshot[] = [];
  private readonly maxSlots: number;
  private page = 0;
  private focused: AgentKey | undefined;

  constructor(opts: AgentSlotManagerOptions = {}) {
    super();
    this.maxSlots = opts.maxSlots ?? DEFAULT_MAX_SLOTS;
  }

  /**
   * Replace the full agent list. Clamps the current page back into
   * range if the list shrank, and clears focus (emitting
   * "focus-lost") if the focused agent is no longer present — a
   * dead `{target, paneId}` would otherwise keep the answer/arrow
   * keys silently targeting an agent that's gone.
   */
  setAgents(agents: readonly AgentSnapshot[]): void {
    this.agentsList = agents;
    const count = this.pageCount();
    if (this.page >= count) this.page = Math.max(0, count - 1);
    if (this.focused && !agents.some((a) => sameAgent(a, this.focused))) {
      this.focused = undefined;
      this.emit("focus-lost");
    }
  }

  /** Full list in daemon order. */
  list(): readonly AgentSnapshot[] {
    return this.agentsList;
  }

  size(): number {
    return this.agentsList.length;
  }

  maxSlotsCount(): number {
    return this.maxSlots;
  }

  pageCount(): number {
    return Math.max(1, Math.ceil(this.agentsList.length / this.maxSlots));
  }

  currentPage(): number {
    return this.page;
  }

  /** Cycle to the next page, wrapping. No-op (stays on page 0) when everything fits on one page. */
  nextPage(): void {
    const count = this.pageCount();
    this.page = (this.page + 1) % count;
  }

  /** Returns the agent at the given 0-indexed slot on the CURRENT page, or undefined. */
  agentAt(slot: number): AgentSnapshot | undefined {
    if (slot < 0 || slot >= this.maxSlots) return undefined;
    return this.agentsList[this.page * this.maxSlots + slot];
  }

  getFocused(): AgentKey | undefined {
    return this.focused;
  }

  setFocused(agent: AgentKey | undefined): void {
    this.focused = agent;
  }

  isFocused(agent: AgentKey): boolean {
    return sameAgent(this.focused, agent);
  }

  /** The full current snapshot of the focused agent (status, name, …), or undefined if nothing is focused. */
  getFocusedAgent(): AgentSnapshot | undefined {
    if (!this.focused) return undefined;
    return this.agentsList.find((a) => sameAgent(a, this.focused));
  }
}

/**
 * Map MK.2 key coordinates to the 0-indexed slot number. Slots live
 * on row 0 only — same layout claudedeck's `sessionSlot.ts` used.
 * Row 1 is answer/wispr/plan and row 2 is arrows + menu, both handled
 * by other action UUIDs. Returning undefined for off-row coordinates
 * leaves those keys' display to whichever action UUID is assigned to
 * them by the profile.
 */
export function slotFromCoordinates(
  coords: { column: number; row: number } | undefined,
): number | undefined {
  if (!coords) return undefined;
  if (coords.row !== 0) return undefined;
  if (coords.column < 0 || coords.column > 4) return undefined;
  return coords.column;
}
