import {
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  action,
} from "@elgato/streamdeck";
import type { AgentSlotManager } from "../agentSlots";
import type { BridgeClient, BridgeState } from "../bridgeClient";
import type { AgentSnapshot, TargetSnapshot } from "../wire";

export interface WorktreeRender {
  title: string;
}

const PENDING_GLYPH = "…";

/**
 * Pure render fn for the Worktree key. The button face is carried by
 * the static `worktree.svg` icon (declared in the manifest) — the
 * title only ever shows two things layered on top of it: the brief
 * in-flight indicator while `worktree:create` is outstanding, and the
 * `!` disconnected marker shared by every command-sending key (answer
 * row, arrows, wispr-flow, menu).
 */
export function renderWorktree(
  pending: boolean,
  bridgeState: BridgeState = "connected",
): WorktreeRender {
  const prefix = bridgeState === "connected" ? "" : "!";
  return { title: pending ? `${prefix}${PENDING_GLYPH}` : prefix };
}

/**
 * Pure policy for "which target does a Worktree press act on?" Prefers
 * the focused agent's target (so the new worktree lands next to
 * whatever the user is looking at); falls back to the first ONLINE
 * target from the latest `targets:update` when nothing is focused —
 * an offline/connecting/protocol-mismatch target can't take a
 * `worktree:create` call, so it's skipped. Returns undefined when
 * there's no focus and no online target, meaning the press has
 * nothing to act on.
 */
export function resolveWorktreeTarget(
  focusedAgent: Pick<AgentSnapshot, "target"> | undefined,
  targets: readonly TargetSnapshot[],
): string | undefined {
  if (focusedAgent) return focusedAgent.target;
  return targets.find((t) => t.state === "online")?.name;
}

/* ----------------------------------------------------------------------
 * SDK adapter
 *
 * Mirrors AgentSlotAction: thin class wrapping the pure functions
 * above. `pending` is owned by the instance (not a Stream-Deck-level
 * setting) so `clearPending()` can be driven straight from plugin.ts's
 * `agents:update` handler — a successful `worktree.create` shows up
 * there as a new agent, which is the daemon-confirmed signal that the
 * in-flight indicator should clear.
 * -------------------------------------------------------------------- */

export interface WorktreeActionDeps {
  bridge: BridgeClient;
  manager: AgentSlotManager;
  /** Latest `targets:update` snapshot — read live, not captured at construction. */
  getTargets: () => readonly TargetSnapshot[];
}

@action({ UUID: "com.nickboy.herddeck.worktree" })
export class WorktreeAction extends SingletonAction {
  private pending = false;

  constructor(private readonly deps: WorktreeActionDeps) {
    super();
  }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const render = renderWorktree(this.pending, this.deps.bridge.state);
    await ev.action.setTitle(render.title);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const target = resolveWorktreeTarget(
      this.deps.manager.getFocusedAgent(),
      this.deps.getTargets(),
    );
    if (!target) {
      await ev.action.showAlert();
      return;
    }
    this.pending = true;
    await this.repaint();
    const sent = this.deps.bridge.send({ type: "worktree:create", target });
    if (!sent) {
      this.pending = false;
      await this.repaint();
      await ev.action.showAlert();
      return;
    }
    // No showOk here — the "…" pending title IS the feedback. A green
    // checkmark would flash and vanish before the daemon confirms
    // anything, same reasoning as Wispr Flow's press-and-hold key.
  }

  /** Clears the in-flight indicator. Call from the `agents:update` handler. */
  async clearPending(): Promise<void> {
    if (!this.pending) return;
    this.pending = false;
    await this.repaint();
  }

  async repaint(): Promise<void> {
    const render = renderWorktree(this.pending, this.deps.bridge.state);
    for (const visible of this.actions) await visible.setTitle(render.title);
  }
}
