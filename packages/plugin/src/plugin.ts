import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Ensure cwd points at the .sdPlugin directory (this file's parent)
// so @elgato/streamdeck can read manifest.json via its default
// relative path resolution. Stream Deck.app typically sets cwd to the
// plugin root, but this guards against future behaviour changes.
try {
  process.chdir(dirname(dirname(fileURLToPath(import.meta.url))));
} catch {
  // cwd change is advisory; `import.meta.url` may not resolve in some
  // bundled runtimes. Let the SDK fall through to its own lookup.
}

const PLUGIN_LOG = join(homedir(), ".herddeck", "plugin.log");
const plog = (msg: string): void => {
  try {
    appendFileSync(PLUGIN_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // log writing is best-effort; never take down the plugin over it.
  }
};

// Visibility for silent crashes. SDA respawns the plugin on uncaught
// exceptions with no user feedback; these handlers at least leave a
// trace in ~/.herddeck/plugin.log so the respawn cycle is debuggable.
// Do NOT call process.exit — let SDA handle the restart.
process.on("uncaughtException", (err: Error) => {
  plog(`FATAL uncaughtException: ${err.message}\n${err.stack ?? "(no stack)"}`);
});
process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
  plog(`FATAL unhandledRejection: ${msg}`);
});

import streamDeck, {
  type KeyDownEvent,
  type KeyUpEvent,
  SingletonAction,
  type WillAppearEvent,
  action,
} from "@elgato/streamdeck";
import { AgentSlotAction, renderAgentSlot, renderAgentSlotImage } from "./actions/agentSlot";
import type { AnswerFocusTarget } from "./actions/answer";
import { renderAnswerKey } from "./actions/answer";
import { renderArrowKey } from "./actions/arrowKey";
import { renderMenu } from "./actions/menu";
import { renderPlaceholder } from "./actions/placeholder";
import { PlanAutoCycle } from "./actions/planAutoCycle";
import { cyclePlanMode, renderPlanUsage, renderPlanUsageImage } from "./actions/planUsage";
import { renderWisprFlow } from "./actions/wisprFlow";
import { AgentSlotManager, slotFromCoordinates } from "./agentSlots";
import { BridgeClient, type BridgeState } from "./bridgeClient";
import type { AnswerKind, PlanMetric, PlanMetricKey, TargetSnapshot, WsEvent } from "./wire";

// Node 20 (Stream Deck's bundled runtime) lacks a global WebSocket.
// Explicitly inject the `ws` package so the bridge client has
// something to instantiate. In Bun / Node 22+ the global is present
// and BridgeClient would fall back to it automatically.
const wsModule = (await import("ws")) as unknown as {
  WebSocket: new (url: string) => unknown;
  default?: new (url: string) => unknown;
};
const WSImpl = (wsModule.WebSocket ?? wsModule.default) as unknown as typeof WebSocket;
const bridge = new BridgeClient({ WebSocketImpl: WSImpl });
const slotManager = new AgentSlotManager();

// Module-level shared state written by bridge events, read by action
// render cycles. Keeping it flat keeps each action class tiny — same
// convention claudedeck's plugin.ts used.
let targets: TargetSnapshot[] = [];
let planMetrics: PlanMetric[] = [];
let planMode: PlanMetricKey = "fiveHour";
let planError: string | undefined;

function isMultiTarget(): boolean {
  return targets.length > 1;
}

/**
 * "Pending" in v2 isn't a separate daemon-pushed map like claudedeck's
 * `pendingBySession` — it's just `AgentSnapshot.status === "blocked"`
 * on whichever agent is currently focused, read straight off the same
 * `agents:update` list the slots render from.
 */
function currentAnswerTarget(): AnswerFocusTarget | undefined {
  const agent = slotManager.getFocusedAgent();
  if (!agent) return undefined;
  return { target: agent.target, paneId: agent.paneId, status: agent.status };
}

// ─── Placeholder ─────────────────────────────────────────────────────

@action({ UUID: "com.nickboy.herddeck.placeholder" })
class PlaceholderAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const { title } = renderPlaceholder(bridge.state);
    await ev.action.setTitle(title);
  }
}

// ─── Answer keys ─────────────────────────────────────────────────────

abstract class AnswerAction extends SingletonAction {
  abstract readonly kind: AnswerKind;

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const { title } = renderAnswerKey(this.kind, currentAnswerTarget(), bridge.state);
    await ev.action.setTitle(title);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const agent = slotManager.getFocusedAgent();
    plog(
      `keyDown answer.${this.kind} focused=${JSON.stringify(slotManager.getFocused()) ?? "none"} status=${agent?.status ?? "none"} bridge=${bridge.state}`,
    );
    // No focused agent → show alert (red X flash), don't fake a
    // confirmation. Previously (in claudedeck) returned silently,
    // leaving the user to wonder whether their press registered.
    if (!agent) {
      await ev.action.showAlert();
      return;
    }
    // bridge.send returns false when WS is disconnected and the
    // command was queued rather than transmitted. Show alert instead
    // of the Stream Deck's default ok-checkmark so the user knows the
    // daemon won't act on this press (see claudedeck's
    // yes-button-bug.md Suspect A — same failure mode ported here).
    const sent = bridge.send({
      type: "agent:answer",
      target: agent.target,
      paneId: agent.paneId,
      kind: this.kind,
    });
    if (!sent) {
      plog(`keyDown answer.${this.kind} DROPPED bridge=${bridge.state}`);
      await ev.action.showAlert();
      return;
    }
    await ev.action.showOk();
  }
}

@action({ UUID: "com.nickboy.herddeck.answer-yes" })
class AnswerYesAction extends AnswerAction {
  readonly kind: AnswerKind = "yes";
}

@action({ UUID: "com.nickboy.herddeck.answer-no" })
class AnswerNoAction extends AnswerAction {
  readonly kind: AnswerKind = "no";
}

@action({ UUID: "com.nickboy.herddeck.answer-always" })
class AnswerAlwaysAction extends AnswerAction {
  readonly kind: AnswerKind = "always";
}

// ─── Plan usage ──────────────────────────────────────────────────────

@action({ UUID: "com.nickboy.herddeck.plan-usage" })
class PlanUsageAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const render = renderPlanUsage(planMetrics, planMode, planError);
    await ev.action.setTitle(render.title);
    await (ev.action as { setImage: (url: string) => Promise<void> }).setImage(
      renderPlanUsageImage(render),
    );
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const keys = planMetrics.map((m) => m.key);
    if (keys.length === 0) return;
    planMode = cyclePlanMode(keys, planMode);
    const render = renderPlanUsage(planMetrics, planMode, planError);
    await ev.action.setTitle(render.title);
    await (ev.action as { setImage: (url: string) => Promise<void> }).setImage(
      renderPlanUsageImage(render),
    );
    // Reset the auto-cycle timer so the user gets a full window with
    // their chosen metric before the next auto-flip.
    planAutoCycle.restart();
  }
}

// ─── Wispr Flow trigger ──────────────────────────────────────────────

@action({ UUID: "com.nickboy.herddeck.wispr-flow" })
class WisprFlowAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const { title } = renderWisprFlow(bridge.state);
    await ev.action.setTitle(title);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    plog(`keyDown wispr-flow bridge=${bridge.state}`);
    // Press-and-hold UX: keyDown starts hands-free dictation, keyUp
    // stops it. Matches Wispr Flow's `Fn` push-to-talk muscle memory
    // — hold to dictate, release to stop.
    const sent = bridge.send({ type: "wispr-flow:start" });
    if (!sent) {
      // Daemon offline — drop the press and surface the alert.
      await ev.action.showAlert();
      return;
    }
    // Skip showOk on keyDown; the green check would clobber the
    // press-and-hold visual feedback. The keyUp handler signals
    // completion instead.
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    plog(`keyUp wispr-flow bridge=${bridge.state}`);
    const sent = bridge.send({ type: "wispr-flow:stop" });
    if (!sent) {
      await ev.action.showAlert();
      return;
    }
    await ev.action.showOk();
  }
}

// ─── Arrow keys ──────────────────────────────────────────────────────

abstract class ArrowKeyAction extends SingletonAction {
  abstract readonly direction: "up" | "down" | "enter";

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const { title } = renderArrowKey(bridge.state);
    await ev.action.setTitle(title);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const agent = slotManager.getFocusedAgent();
    plog(
      `keyDown arrow:${this.direction} focused=${JSON.stringify(slotManager.getFocused()) ?? "none"} bridge=${bridge.state}`,
    );
    if (!agent) {
      await ev.action.showAlert();
      return;
    }
    const sent = bridge.send({
      type: "agent:keys",
      target: agent.target,
      paneId: agent.paneId,
      keys: [this.direction],
    });
    if (!sent) {
      await ev.action.showAlert();
      return;
    }
    await ev.action.showOk();
  }
}

@action({ UUID: "com.nickboy.herddeck.arrow-up" })
class ArrowUpAction extends ArrowKeyAction {
  readonly direction = "up" as const;
}

@action({ UUID: "com.nickboy.herddeck.arrow-down" })
class ArrowDownAction extends ArrowKeyAction {
  readonly direction = "down" as const;
}

@action({ UUID: "com.nickboy.herddeck.enter" })
class EnterAction extends ArrowKeyAction {
  readonly direction = "enter" as const;
}

// ─── Menu (paging) ───────────────────────────────────────────────────

@action({ UUID: "com.nickboy.herddeck.menu" })
class MenuAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const { title } = renderMenu({
      agentCount: slotManager.size(),
      page: slotManager.currentPage(),
      pageCount: slotManager.pageCount(),
      bridgeState: bridge.state,
    });
    await ev.action.setTitle(title);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    // No-op (but harmless) when everything fits on one page —
    // AgentSlotManager.nextPage() stays on page 0 in that case.
    slotManager.nextPage();
    await repaintSlots();
    const { title } = renderMenu({
      agentCount: slotManager.size(),
      page: slotManager.currentPage(),
      pageCount: slotManager.pageCount(),
      bridgeState: bridge.state,
    });
    await ev.action.setTitle(title);
  }
}

// ─── Instances + repaint helpers ─────────────────────────────────────

const placeholderAction = new PlaceholderAction();
const agentSlotAction = new AgentSlotAction({
  bridge,
  manager: slotManager,
  isMultiTarget,
});
const answerActions = [new AnswerYesAction(), new AnswerNoAction(), new AnswerAlwaysAction()];
const planUsageAction = new PlanUsageAction();
// Auto-cycles planMode every few seconds so the user can passively
// see both 5h and 7d allowances without pressing the key. Manual press
// in PlanUsageAction.onKeyDown still cycles immediately AND calls
// restart() so the user keeps their chosen metric for a full window.
const planAutoCycle = new PlanAutoCycle({
  advance: () => {
    const keys = planMetrics.map((m) => m.key);
    if (keys.length === 0) return;
    planMode = cyclePlanMode(keys, planMode);
    void repaintPlan();
  },
  metricCount: () => planMetrics.length,
});
const wisprFlowAction = new WisprFlowAction();
const arrowUpAction = new ArrowUpAction();
const arrowDownAction = new ArrowDownAction();
const enterAction = new EnterAction();
const menuAction = new MenuAction();

async function repaintAnswers(): Promise<void> {
  const target = currentAnswerTarget();
  plog(
    `repaintAnswers focused=${JSON.stringify(slotManager.getFocused()) ?? "none"} status=${target?.status ?? "-"} bridge=${bridge.state}`,
  );
  for (const inst of answerActions) {
    const { title } = renderAnswerKey(inst.kind, target, bridge.state);
    for (const visible of inst.actions) await visible.setTitle(title);
  }
}

async function repaintSlots(): Promise<void> {
  const details: string[] = [];
  for (const visible of agentSlotAction.actions) {
    const key = visible as { coordinates?: { column: number; row: number } };
    const slot = slotFromCoordinates(key.coordinates);
    const agent = slot === undefined ? undefined : slotManager.agentAt(slot);
    const focused = agent ? slotManager.isFocused(agent) : false;
    const render = renderAgentSlot(agent, focused, isMultiTarget());
    await visible.setTitle(render.title);
    await (visible as { setImage: (url: string) => Promise<void> }).setImage(
      renderAgentSlotImage(render),
    );
    details.push(`[${slot}=${agent ? `"${render.displayName ?? ""}"` : "∅"}]`);
  }
  plog(
    `repaintSlots size=${slotManager.size()} page=${slotManager.currentPage() + 1}/${slotManager.pageCount()} ${details.join("")}`,
  );
}

async function repaintPlan(): Promise<void> {
  const render = renderPlanUsage(planMetrics, planMode, planError);
  const image = renderPlanUsageImage(render);
  for (const visible of planUsageAction.actions) {
    await visible.setTitle(render.title);
    await (visible as { setImage: (url: string) => Promise<void> }).setImage(image);
  }
}

async function repaintMenu(): Promise<void> {
  const { title } = renderMenu({
    agentCount: slotManager.size(),
    page: slotManager.currentPage(),
    pageCount: slotManager.pageCount(),
    bridgeState: bridge.state,
  });
  for (const visible of menuAction.actions) await visible.setTitle(title);
}

async function repaintWisprFlow(): Promise<void> {
  const { title } = renderWisprFlow(bridge.state);
  for (const visible of wisprFlowAction.actions) await visible.setTitle(title);
}

async function repaintArrows(): Promise<void> {
  const { title } = renderArrowKey(bridge.state);
  for (const visible of [
    ...arrowUpAction.actions,
    ...arrowDownAction.actions,
    ...enterAction.actions,
  ]) {
    await visible.setTitle(title);
  }
}

// ─── Bridge subscriptions ────────────────────────────────────────────

bridge.on("state", async (state: BridgeState) => {
  const { title, highlight } = renderPlaceholder(state);
  for (const visible of placeholderAction.actions) {
    await visible.setTitle(title);
    if (highlight && "showOk" in visible) {
      await (visible as { showOk: () => Promise<void> }).showOk();
    }
  }
  // Row 2 keys carry a `!` prefix when the bridge is down so the user
  // can see presses won't flow through — repaint on every state flip.
  await repaintAnswers();
  await repaintMenu();
  await repaintWisprFlow();
  await repaintArrows();
});

bridge.on("event", async (event: WsEvent) => {
  plog(
    `event ${event.type} agents=${slotManager.size()} visible=${agentSlotAction.actions.length}`,
  );
  switch (event.type) {
    case "daemon:ready": {
      // Treat this as "fresh start" — clear stale state so a daemon
      // restart doesn't leave us with agents the new daemon process
      // doesn't know about. The daemon immediately follows up with
      // `targets:update` + `agents:update` for its current state, so
      // the managers get repopulated with the actual live set.
      slotManager.setAgents([]);
      slotManager.setFocused(undefined);
      targets = [];
      await repaintSlots();
      await repaintAnswers();
      await repaintMenu();
      return;
    }
    case "targets:update": {
      targets = event.targets;
      // Multi-target suffix on slot renders depends on targets.length.
      await repaintSlots();
      await repaintMenu();
      return;
    }
    case "agents:update": {
      slotManager.setAgents(event.agents);
      await repaintSlots();
      await repaintAnswers();
      await repaintMenu();
      return;
    }
    case "plan:update": {
      planMetrics = event.snapshot.metrics;
      planError = undefined;
      await repaintPlan();
      return;
    }
    case "plan:error": {
      planError = event.reason;
      await repaintPlan();
      return;
    }
  }
});

slotManager.on("focus-lost", () => {
  void repaintSlots();
  void repaintAnswers();
});

// ─── Register + start ───────────────────────────────────────────────

streamDeck.actions.registerAction(placeholderAction);
streamDeck.actions.registerAction(agentSlotAction);
for (const inst of answerActions) streamDeck.actions.registerAction(inst);
streamDeck.actions.registerAction(planUsageAction);
streamDeck.actions.registerAction(wisprFlowAction);
streamDeck.actions.registerAction(arrowUpAction);
streamDeck.actions.registerAction(arrowDownAction);
streamDeck.actions.registerAction(enterAction);
streamDeck.actions.registerAction(menuAction);

// Start auto-cycling between 5h / 7d (and any future buckets) on the
// Plan Usage key. Self-suppresses when fewer than 2 metrics are known
// — the cycle only fires when there's actually something to flip to.
planAutoCycle.start();

bridge.start();
await streamDeck.connect();
