import type { BridgeState } from "../bridgeClient";

export interface PlaceholderRender {
  title: string;
  highlight: boolean;
}

/**
 * Pure function mapping bridge state to what the placeholder Stream
 * Deck key renders. Testable in isolation; the thin SDK adapter in
 * `plugin.ts` passes the result into `key.setTitle` and
 * `key.showOk`/`showAlert`. Ported from claudedeck's
 * `actions/placeholder.ts` with the branding swapped.
 */
export function renderPlaceholder(state: BridgeState): PlaceholderRender {
  switch (state) {
    case "connected":
      return { title: "HerdDeck\nready", highlight: true };
    case "connecting":
      return { title: "connecting…", highlight: false };
    default:
      return { title: "HerdDeck\noffline", highlight: false };
  }
}
