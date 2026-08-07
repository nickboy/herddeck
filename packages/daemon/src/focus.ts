// Bring the terminal app hosting herdr to the foreground. `open -a`
// needs no Accessibility/TCC grant — the whole reason jump-to-tab got
// simple in the herdr rebuild (herdr's agent.focus selects the right
// pane; we only need the app frontmost). Local targets only.

export async function focusTerminalApp(app: string): Promise<void> {
  const proc = Bun.spawn(["open", "-a", app], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    console.error(`focusTerminalApp: open -a ${app} exited ${code}: ${err.trim()}`);
  }
}
