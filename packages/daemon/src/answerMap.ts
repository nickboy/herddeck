// Maps a Stream Deck answer key (yes / no / always) to the logical
// keys herdr should type into a blocked agent's TUI, per agent kind.
//
// Claude Code's permission menu is numbered: 1 = allow once,
// 2 = allow always (project), 3 = deny. Digits select immediately;
// the trailing "enter" is belt-and-suspenders inherited from
// ClaudeDeck's proven `1\r` behavior (harmless no-op on an empty
// input box once the menu is gone).
//
// Other agent kinds fall back to the Claude convention until their
// TUIs are verified on hardware (master plan Phase 2 checklist).

export type AnswerKind = "yes" | "no" | "always";

const CLAUDE_MAP: Record<AnswerKind, string[]> = {
  yes: ["1", "enter"],
  always: ["2", "enter"],
  no: ["3", "enter"],
};

const BY_AGENT_KIND: Record<string, Record<AnswerKind, string[]>> = {
  claude: CLAUDE_MAP,
};

export function answerKeys(agentKind: string | null, kind: AnswerKind): string[] {
  return agentKind && BY_AGENT_KIND[agentKind] ? BY_AGENT_KIND[agentKind][kind] : CLAUDE_MAP[kind];
}
