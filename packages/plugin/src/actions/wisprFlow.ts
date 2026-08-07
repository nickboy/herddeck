import type { BridgeState } from "../bridgeClient";

export interface WisprFlowRender {
  title: string;
}

/**
 * Pure render fn for the Wispr Flow trigger key. The button face is
 * static — there's no per-press state to display — so the title is
 * the same as long as the bridge is up. When the bridge is offline,
 * we prefix with `!` to signal that a press won't reach the daemon
 * (same convention as the answer keys' "!YES" / "!NO"). Ported
 * unchanged from claudedeck — Wispr Flow behaviour is identical in
 * v2 (`wispr-flow:start` on keyDown, `wispr-flow:stop` on keyUp).
 */
export function renderWisprFlow(state: BridgeState): WisprFlowRender {
  const prefix = state === "connected" ? "" : "!";
  return { title: `${prefix}wispr\nflow` };
}
