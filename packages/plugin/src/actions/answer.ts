import type { AgentStatus, AnswerKind } from "../wire";

export type { AnswerKind } from "../wire";

/**
 * Bridge state visible to renderers. Mirror of BridgeClient's public
 * `state` field. Kept as a local type so `actions/answer.ts` stays
 * free of SDK imports — same convention as claudedeck's
 * `actions/permission.ts`.
 */
export type AnswerBridgeState = "disconnected" | "connecting" | "connected";

export interface AnswerFocusTarget {
  target: string;
  paneId: string;
  status: AgentStatus;
}

export interface AnswerKeyRender {
  title: string;
  highlight: boolean;
}

const LABELS: Record<AnswerKind, string> = {
  yes: "YES",
  no: "NO",
  always: "ALL",
};

/**
 * Pure render fn. `focused` describes the agent the answer row would
 * currently act on (or undefined if nothing's focused). Unlike
 * claudedeck — which tracked a daemon-pushed `pendingBySession` map
 * because `permission:pending`/`permission:resolved` were distinct
 * WS events — the v2 protocol has no such events: "pending" is just
 * `AgentSnapshot.status === "blocked"` on whichever agent is
 * focused, straight from the same `agents:update` list the slots
 * render from. So the highlight/target-tag only lights up when the
 * focused agent is actually blocked; a focus on a healthy agent
 * renders the same as "nothing focused".
 *
 * `bridgeState` signals whether the plugin↔daemon WS is live — if
 * not, the title gets a `!` prefix so the user can see at a glance
 * that pressing won't do anything (same convention claudedeck used
 * after the yes-button-bug investigation).
 */
export function renderAnswerKey(
  kind: AnswerKind,
  focused: AnswerFocusTarget | undefined,
  bridgeState: AnswerBridgeState = "connected",
): AnswerKeyRender {
  const label = LABELS[kind];
  const disconnectedPrefix = bridgeState === "connected" ? "" : "!";
  if (!focused || focused.status !== "blocked") {
    return { title: `${disconnectedPrefix}${label}`, highlight: false };
  }
  const tag = focused.paneId.length > 4 ? focused.paneId.slice(-4) : focused.paneId;
  return { title: `${disconnectedPrefix}${label}\n→ ${tag}`, highlight: true };
}
