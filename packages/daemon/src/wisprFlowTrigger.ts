import { type spawn as nodeSpawn, spawn } from "node:child_process";
import { logInfo } from "./log";

/**
 * Wispr Flow's undocumented URL scheme handlers. Declared in the
 * app's `Info.plist` (`CFBundleURLTypes` → `wispr-flow`) and routed
 * through the same internal state machine as the global hotkey
 * (verified by reading the deeplink dispatcher in `app.asar`):
 *
 *   wispr-flow://start-hands-free   → starts hands-free dictation
 *                                     (no-op when already listening)
 *   wispr-flow://stop-hands-free    → stops it (no-op when idle)
 *
 * Why this path instead of synthesizing the configured hotkey:
 * macOS's WindowServer matches Carbon `RegisterEventHotKey`
 * registrations against incoming events INSIDE the WindowServer
 * process, before per-app dispatch. `CGEventPost` and AppleScript
 * `keystroke` produce events that WindowServer's
 * `CGXSenderCanSynthesizeEvents()` gate rejects as not-from-the-real-
 * keyboard, regardless of `kCGEventSourceStateID`. See
 * `docs/2026-05-09-wispr-flow-hotkey-research.md` for the deep dive.
 *
 * The deeplink path bypasses keystroke synthesis entirely.
 */
const URL_BY_ACTION = {
  start: "wispr-flow://start-hands-free",
  stop: "wispr-flow://stop-hands-free",
} as const;

export type TriggerAction = keyof typeof URL_BY_ACTION;

export interface RunTriggerOptions {
  /**
   * Override the spawn implementation. Tests pass a stub so they
   * don't actually launch `open` (which would side-effect the
   * developer's machine). Defaults to `node:child_process`'s `spawn`.
   */
  spawnImpl?: typeof nodeSpawn;
}

/**
 * Open Wispr Flow's hands-free start or stop deeplink. Detached +
 * unref'd so the daemon's WS message loop doesn't block on `open`'s
 * spawn time. Errors are caught and logged — a spawn failure (e.g.
 * Wispr Flow not installed and `open` errors) shouldn't take down
 * the daemon.
 *
 * Critical flag: `-g` ("background") tells `open` not to bring
 * Wispr Flow to the foreground. Without it, the act of opening the
 * URL steals focus from whatever app the user was typing in
 * (typically Ghostty + Claude Code), and Wispr Flow's transcribed
 * text would land in Wispr Flow's own window instead of where the
 * user actually wants it.
 *
 * Mirrors `ghosttyFocus.runJump`'s shape so the diagnostic pattern
 * (stdout/stderr captured to `~/.claudedeck/daemon.log`) is
 * consistent across daemon-side side-effects.
 */
export function runTrigger(action: TriggerAction, opts: RunTriggerOptions = {}): void {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const url = URL_BY_ACTION[action];
  try {
    const proc = spawnImpl("open", ["-g", url], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) logInfo(`open: ${msg}`);
    });
    proc.stderr?.on("data", (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) logInfo(`open stderr: ${msg}`);
    });
    proc.on("error", (err: Error) => {
      logInfo(`open spawn error: ${err.message}`);
    });
    proc.unref();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logInfo(`open spawn failed: ${message}`);
  }
}
