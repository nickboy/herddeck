import type { BridgeState } from "../bridgeClient";

export interface MenuRender {
  title: string;
  alert: boolean;
}

export interface RenderMenuInput {
  agentCount: number;
  /** 0-indexed current page (AgentSlotManager.currentPage()). */
  page: number;
  /** AgentSlotManager.pageCount() — always ≥ 1. */
  pageCount: number;
  bridgeState: BridgeState;
}

/**
 * MENU key — shows agent count + a disconnect marker, and cycles
 * pages when the agent list overflows the 5 visible slots (see
 * docs/CONTRACTS.md: "menu (paging)").
 *
 * Deviates from claudedeck's `menu.ts`, which toggled a
 * default/diagnostic view: claudedeck capped sessions at
 * MAX_SESSIONS with LRU eviction, so there was never more than 5 to
 * show and nothing to page through. Here the daemon pushes the FULL
 * agent list on every `agents:update`, so paging is the real overflow
 * mechanism — pressing MENU (handled in the SDK adapter) advances
 * `AgentSlotManager.nextPage()` and repaints the slot row.
 */
export function renderMenu({
  agentCount,
  page,
  pageCount,
  bridgeState,
}: RenderMenuInput): MenuRender {
  const alert = bridgeState !== "connected";
  const marker = alert ? "‼ " : "";

  if (pageCount <= 1) {
    return {
      title: `${marker}${agentCount} agnt${agentCount === 1 ? "" : "s"}\nMENU`,
      alert,
    };
  }

  return {
    title: `${marker}${agentCount} agnts\nPG ${page + 1}/${pageCount}`,
    alert,
  };
}
