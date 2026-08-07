import {
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  action,
} from "@elgato/streamdeck";
import type { AgentSlotManager } from "../agentSlots";
import type { BridgeClient } from "../bridgeClient";

/**
 * Per-key Stream Deck setting — the text `prompt:canned` sends. The
 * index signature (rather than importing `JsonObject` from
 * `@elgato/utils`, a transitive dep not declared directly by this
 * package) is what satisfies `SingletonAction<T extends JsonObject>`'s
 * generic constraint.
 */
export interface CannedPromptSettings {
  text?: string;
  [key: string]: string | undefined;
}

export const DEFAULT_CANNED_TEXT = "continue";

export interface CannedPromptRender {
  title: string;
}

/**
 * Line budget mirrors agentSlot's per-line character budget (8-10
 * chars) times the ~3 lines a 72px key can show at the manifest's
 * FontSize before the Stream Deck app's own wrapping starts clipping.
 * Plain slice, no ellipsis — same truncation style as agentSlot's
 * `truncate` (the button is small enough that an ellipsis eats into
 * an already-tight budget without adding much clarity).
 */
const TITLE_MAX_CHARS = 24;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * Pure policy for "what text does this press actually send?" Falls
 * back to `DEFAULT_CANNED_TEXT` when the per-key setting is unset or
 * blank — a key dragged onto the deck before the user configures it
 * still does something sensible (matches claudedeck's convention of
 * every action being safe to press unconfigured).
 */
export function resolveCannedPromptText(text: string | undefined): string {
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_CANNED_TEXT;
}

/** Pure render fn — title IS the canned text (truncated to fit the key). */
export function renderCannedPrompt(text: string | undefined): CannedPromptRender {
  return { title: truncate(resolveCannedPromptText(text), TITLE_MAX_CHARS) };
}

/* ----------------------------------------------------------------------
 * SDK adapter
 *
 * No dedicated icon asset exists for this action (only worktree.svg
 * and target-switcher.svg were provided) — the manifest points its
 * Icon/State image at the existing enter.svg glyph, since "submit
 * canned text" is closest in spirit to the Enter key's send-it
 * meaning. The title text carries the actual per-key identity.
 * -------------------------------------------------------------------- */

export interface CannedPromptActionDeps {
  bridge: BridgeClient;
  manager: AgentSlotManager;
}

@action({ UUID: "com.nickboy.herddeck.canned-prompt" })
export class CannedPromptAction extends SingletonAction<CannedPromptSettings> {
  constructor(private readonly deps: CannedPromptActionDeps) {
    super();
  }

  override async onWillAppear(ev: WillAppearEvent<CannedPromptSettings>): Promise<void> {
    const render = renderCannedPrompt(ev.payload.settings.text);
    await ev.action.setTitle(render.title);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<CannedPromptSettings>,
  ): Promise<void> {
    const render = renderCannedPrompt(ev.payload.settings.text);
    await ev.action.setTitle(render.title);
  }

  override async onKeyDown(ev: KeyDownEvent<CannedPromptSettings>): Promise<void> {
    const agent = this.deps.manager.getFocusedAgent();
    if (!agent) {
      await ev.action.showAlert();
      return;
    }
    const text = resolveCannedPromptText(ev.payload.settings.text);
    const sent = this.deps.bridge.send({
      type: "prompt:canned",
      target: agent.target,
      paneId: agent.paneId,
      text,
    });
    if (!sent) {
      await ev.action.showAlert();
      return;
    }
    await ev.action.showOk();
  }
}
