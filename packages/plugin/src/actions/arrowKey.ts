import type { BridgeState } from "../bridgeClient";

export interface ArrowKeyRender {
  title: string;
}

/**
 * Pure render fn for the up/down/enter keys. Title is intentionally
 * empty — the button's visual is carried entirely by the SVG icon
 * (`assets/arrow-up.svg` / `assets/arrow-down.svg` / `assets/enter.svg`).
 * When the bridge is offline, we prefix `!` so the user can see a
 * press won't reach the daemon (same convention as the answer keys
 * and the Wispr Flow trigger). Ported unchanged from claudedeck.
 */
export function renderArrowKey(state: BridgeState): ArrowKeyRender {
  return { title: state === "connected" ? "" : "!" };
}
