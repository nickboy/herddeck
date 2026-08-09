# HerdDeck

Stream Deck plugin + Bun daemon that controls [herdr](https://herdr.dev)
agent sessions — local and remote — from physical keys.

Successor to [ClaudeDeck](https://github.com/nickboy/claudedeck), rebuilt
on herdr's socket API: agent lifecycle states (`idle/working/blocked/done`)
come from herdr itself, so there are no Claude hooks, no statusline
patching, no AppleScript, and every agent kind herdr recognizes (Claude
Code, Codex, OpenCode, …) works out of the box. Remote machines are
reached by forwarding the remote `herdr.sock` over SSH — the daemon
speaks one protocol to every target.

![HerdDeck page 1 on a Stream Deck MK.2: five agent slots with live
context donuts, answer keys, Wispr Flow, plan usage, and the navigation
cluster](docs/images/stream-deck-page-1.png)

Page 1, live against five agents on a remote machine. The top row is one
key per agent — the ring is that session's context window, the tint is
its lifecycle state (here the first slot is highlighted because it is
working). The fifth slot has no ring because that pane has not been
detected as an agent yet. Bottom right cycles the 5-hour and 7-day plan
limits with their reset countdowns.

## Layout

| Package | Purpose |
| --- | --- |
| `packages/protocol` | Committed herdr API schema + generated TS types + NDJSON codec |
| `packages/daemon` | Bun daemon: HerdrClient, SessionRegistry, StateCache, TunnelManager, WS server |
| `packages/plugin` | Stream Deck plugin (SDK v2) |
| `packages/cli` | `herddeck` CLI: install / doctor / status / targets |

Development plan and phase results live in `docs/plans/`. CI checks and
branch protection are documented in `docs/ci.md`.
[`docs/engineering-notes.md`](docs/engineering-notes.md) is the write-up:
what the protocol actually does, the bugs only live execution found, and
the options that were rejected and why.

## Status

v0.1: daemon, plugin, and CLI implemented and live-verified against
herdr 0.8.0 (protocol 19); the daemon pings and compares protocol
versions per target on connect and degrades mismatched targets to a
warning state. Deployed across two machines — laptop running the Stream
Deck and daemon, desktop running herdr and the agents, joined by an SSH
tunnel — with all five agent slots, the context donuts, and plan usage
live.

Remaining field work: pressing an answer key against a real blocked
prompt, to confirm the `["1","enter"]` mapping on hardware.

## Known limitations and future work

### The context window size is a constant

`herddeck-ctx-scan` divides a session's token count by an assumed 1M
window. That number is not discoverable anywhere the script can reach:

| Source | Has the window size? |
| --- | --- |
| statusline payload | yes — `context_window.context_window_size` |
| transcript `.jsonl` | no — `message.model` drops the `[1m]` marker |
| `~/.claude/sessions/<pid>.json` | no |
| `~/.claude/settings.json` | only the *default* model, wrong after `/model` |
| hook payloads | no — excluded by the hooks documentation |

A model→window lookup table was rejected on purpose: it rots on every
model release, and being silently wrong about a percentage is worse than
not showing one. So the token count — which is always correct — is what
the script actually derives, and only the final division depends on the
constant. An overrun clamps to 100% rather than drawing a 216% ring.

That rejection is not theoretical. A survey of the ecosystem found two
shipping tools reporting context five times too low for exactly this
reason: both normalise the model string without stripping the `[1m]`
long-context suffix, so a 1M session misses the table and falls back to
a 200K family entry. A table does not fail loudly when a new window
ships — it keeps answering, wrongly.

The statusline route avoids the whole question by construction: Claude
Code resolves the window itself (including the `[1m]` suffix and the
`context-1m` beta) and hands the statusline an already-computed
`used_percentage`. Reading that number is why the preferred route cannot
rot.

One alternative was found and not taken: scraping Claude Code's own
`/context` output (via `tmux capture-pane`, or by resuming the session
and sending the command). It needs no table and no statusline, and is
rot-free because Claude Code computes the number — but it is brittle to
any UI change, and the resume variant mutates the session it measures.
Recorded here because it is the only known way to get the true window
for a session you did not spawn.

Anthropic's API exposes `max_input_tokens` per model id, which is
machine-readable and rot-free but structurally blind to the `[1m]`
variants — so it cannot answer this question either.

Two design choices are worth keeping for the reasons other tools
illustrate. `ctx-scan` includes `cache_read_input_tokens` in its total,
normally the largest component and omitted by at least one shipping
tool. And it skips a pane it cannot resolve instead of guessing, which
matches the best-behaved implementation surveyed — returning "unknown"
rather than fabricating a number.

One claim to keep an eye on: it has been argued elsewhere that deriving
usage from the transcript systematically under-reports, because
per-message usage excludes system-prompt, tool-schema and MCP overhead.
Measurement here does not support that for the figure `ctx-scan`
actually computes — it agreed exactly with the statusline on three live
sessions, one of them running several MCP servers, because the newest
request's `input + cache_creation + cache_read` is the same quantity
Claude Code itself divides. The caveat likely applies to summing
per-message tokens instead. Recorded as a risk to re-check, not as a
known defect.

### Prefer the statusline route where you can edit it

Both routes were run side by side against the same four live sessions and
agreed exactly, but they are not equivalent in robustness:

| | statusline | `ctx-scan` |
| --- | --- | --- |
| Percentage | exact, from Claude Code | needs the window assumption above |
| Coverage | every session | needs two fallbacks to match |
| Cost | none | one polling process |
| Requires | editing that machine's statusline | nothing |

`ctx-scan` exists for machines whose statusline belongs to someone else.
It is the fallback, not the default.

### herdr does not always know a pane's Claude session

Observed live: `agent_session` was `null` for one of four Claude panes.
`ctx-scan` recovers those by joining herdr's per-pane process list against
`claude agents --json`, but a pane neither route resolves is skipped
rather than guessed at — its donut stays dark. Worth revisiting if herdr's
own detection improves.

## Setup

### Prerequisites

- [herdr](https://herdr.dev) ≥ 0.8.0 (protocol 19) running on every
  machine you want HerdDeck to see, local or remote.
- [Bun](https://bun.sh) ≥ 1.2.
- The Stream Deck app (macOS, Apple Silicon), for the plugin half.

### Install

```bash
git clone https://github.com/nickboy/herddeck.git
cd herddeck
./install.sh
```

That is the whole install. It resolves dependencies, runs the test
suite, builds the Stream Deck plugin bundle, links the `herddeck` CLI
and the two reporter scripts into `~/.local/bin`, bootstraps the daemon
as a `launchd` LaunchAgent, and installs the plugin into Stream Deck —
quitting and relaunching the app, because Stream Deck only scans its
`Plugins/` directory at launch.

Re-run the same command to upgrade. Nothing else needs remembering:
running only part of it is the failure mode this replaced, where a
freshly-pulled daemon ends up paired with a stale plugin and keys stop
responding for no visible reason.

Pass `--no-plugin` to skip the Stream Deck half (useful on a machine
that runs agents but no deck, and in scripts that must not disturb a
running app).

The one manual step left is importing the key layout, printed at the end
of the install:

```bash
open packages/plugin/com.nickboy.herddeck.sdPlugin/HerdDeck.streamDeckProfile
```

The plugin supplies the *actions*; the profile arranges them into pages.
You need both — importing only the profile yields blank keys. Page 1
mirrors ClaudeDeck's proven layout: five agent slots on top, answer keys
plus Wispr Flow and plan usage in the middle, the arrows/Enter cluster at
the bottom. Page 2 holds the herdr-native keys (worktree, canned prompt,
target switcher, slot paging).

Then verify:

```bash
herddeck doctor
```

`doctor` checks herdr is on `PATH` with a matching protocol version, the
local herdr socket exists with sane permissions, the daemon's `/health`
endpoint responds, the `launchd` job is loaded, `~/.herddeck/run/` has
0700 permissions, and (per remote target) an SSH reachability pre-check
plus a `ping` probe through its tunnel socket rather than trusting the
socket file's mere existence — see "Remote targets" below.

The daemon needs a herdr server already running for its local target; it
never starts one itself. An absent socket just means the target shows
offline.

HTTPS clone on purpose: it needs no key setup, and `gh auth setup-git`
makes pushes work non-interactively afterwards. Use the SSH remote only
on a machine whose agent can sign without a prompt.

For live-reload plugin development,
`streamdeck link packages/plugin/com.nickboy.herddeck.sdPlugin` (Elgato
CLI, after `streamdeck dev`) works too. Once published, the plugin will
also be available from the Elgato Marketplace.

### Configuration

Targets, the daemon port, and the terminal app used for `agent:focus`
all live in `~/.herddeck/config.toml`. A missing file defaults to a
single local target on herdr's default socket.

```toml
[daemon]
port = 9137            # optional, default 9137

[ui]
terminal_app = "Ghostty"  # optional

[plan_usage]
enabled = true         # optional, default true

[[targets]]
name = "local"         # required, unique, [a-z0-9-]+
kind = "local"         # "local" | "remote"
socket = "~/.config/herdr/herdr.sock"   # optional; default for local
session = "name"       # optional named session → ~/.config/herdr/sessions/<name>/herdr.sock

[[targets]]
name = "workbox"
kind = "remote"
host = "workbox"                          # ssh destination (~/.ssh/config applies)
remote_socket = "/home/you/.config/herdr/herdr.sock"  # ABSOLUTE path on the remote (sshd does not expand ~)
# named remote sessions: write the full sessions/<name>/herdr.sock path
# yourself — there's no remote equivalent of `session = "name"` above,
# see "Remote targets" below.
```

### Context donut (statusline hookup)

The Agent Slot key's context-window donut is populated by
`AgentInfo.tokens.ctx_pct`, which HerdDeck reads straight from herdr — no
daemon-side polling is involved. Nothing reports that value on its own,
so a fresh install shows no donut until you wire up one of the two paths
below. Claude Code hands the context percentage to the statusline
command on every turn, which makes the statusline the natural reporter.

**Already have a statusline you like? Keep it — add one line.**
`herddeck-report-ctx` (linked onto `PATH` by `install.sh`) takes a
percentage and writes it to herdr; that is the whole integration:

```bash
# in your own statusline script, wherever it already knows the percentage
herddeck-report-ctx "$PCT" &
```

Read the percentage from `.context_window.used_percentage` on the
statusline's stdin JSON. The `&` keeps a hung socket from ever stalling
your prompt.

**No statusline yet?** Use the bundled delegate, which reports *and*
renders nothing of its own — add it to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/absolute/path/to/herddeck/scripts/herddeck-statusline.sh"
  }
}
```

It also works chained in front of another command: it echoes the
upstream command's rendered text off the `display` field of its own
stdin JSON verbatim, so it never clobbers a richer statusline.

**Can't touch the statusline at all?** On a machine whose statusline is
managed by someone else, run `scripts/herddeck-ctx-scan` on that machine
instead. It changes nothing in anyone's configuration — it asks the local
herdr which Claude session each pane is running and reads the token count
out of the transcript Claude Code already writes:

```bash
herddeck-ctx-scan            # one pass
herddeck-ctx-scan --interval 10   # keep reporting
herddeck-ctx-scan --dry-run -v    # show what it would report
```

The trade-off is the window size. The percentage needs a limit to divide
by, and that number appears in exactly one place — the statusline
payload's `context_window.context_window_size`. It is in neither the
transcript (whose `message.model` drops the `[1m]` long-context marker),
nor `~/.claude/sessions/*.json`, nor any hook payload. So this script
assumes 1M and takes `HERDDECK_CONTEXT_WINDOW` to override it. The token
count itself is always right; only the division depends on that constant,
and an overrun clamps to 100% rather than rendering a nonsensical ring.

Prefer the statusline wherever you can edit it: it is exact, needs no
assumption, and costs no extra process.

Both statusline paths share the same writer and the same guarantees. They rely on
herdr's injected `HERDR_PANE_ID` / `HERDR_SOCKET_PATH` environment
variables and fail silently — never breaking the prompt — when those
are absent, when herdr is stopped, or when the percentage isn't a
number in `0..100`. herdr's `tokens` map is newest-write-wins across
sources, so reporting overwrites any stale `ctx_pct` left by an earlier
reporter; no cleanup is needed. Metadata doesn't survive a herdr server
restart, but the statusline re-reports every turn, so the donut
self-heals within one turn.

This is also why the donut is remote-free-of-charge: the statusline runs
on whichever machine the agent runs on and writes to *that* machine's
herdr, and the daemon reads it back through the tunnel already
forwarding that socket.

### Topology: where each piece runs

The Stream Deck, the Stream Deck app, and the HerdDeck daemon must all
be on the **same machine** — the plugin talks to `127.0.0.1:9137`. The
herdr *servers* can be anywhere; the daemon reaches remote ones over
SSH. So for a laptop driving a desktop's agents:

```text
MacBook  ── Stream Deck + plugin + herddeck daemon ──┐
                                                      │ ssh -N -L (tunnel)
Mac mini ── herdr server (agents run here) ───────────┘
```

The laptop needs no local herdr at all — configure only the remote
target. You typically also watch those panes on the laptop through
`herdr --remote`, which is why `agent:focus` foregrounds the terminal
app for remote targets too (`focus_terminal`, default true; set it
false for a target whose panes you never view locally).

### Remote targets

Remote targets are reached by forwarding the remote `herdr.sock` over
SSH (`TunnelManager`, lazy `ssh -N -L`, `~/.herddeck/run/<target>.sock`
locally). The tunnel runs non-interactively (`BatchMode=yes`), so the
target's SSH auth must not require a prompt:

- Key-based or `ssh-agent`-based auth only — no password prompts.
  `ssh -o BatchMode=yes <host>` should succeed with zero interaction
  before you add the target to `config.toml`.
- The remote sshd needs `AllowStreamLocalForwarding` enabled for the
  unix-socket `-L` forward (this is the default; `StreamLocalBindUnlink`
  is unrelated — that setting only affects `-R` remote forwards).
- If your SSH key lives in 1Password, launchd does **not** inherit
  `SSH_AUTH_SOCK` from your login shell, so the daemon's `ssh` process
  can't find the agent unless the target's `~/.ssh/config` entry
  hardcodes the agent socket:

  ```text
  Host workbox
    IdentityAgent ~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock
  ```

- **Named sessions on a remote target**: `remote_socket` has no
  equivalent of the local target's `session` shortcut — write out the
  full absolute path yourself:

  ```toml
  [[targets]]
  name = "workbox-review"
  kind = "remote"
  host = "workbox"
  remote_socket = "/home/you/.config/herdr/sessions/review/herdr.sock"
  ```

  The named session must have been started at least once on the
  remote (`herdr --session review` or equivalent, run on `workbox`
  itself) before that path exists — otherwise the tunnel binds fine
  locally but `doctor`'s ping probe (or the daemon itself) finds
  nothing listening on the far end.
- A composing `session` field for remote targets (mirroring the local
  target's `session = "name"` → `~/.config/herdr/sessions/<name>/herdr.sock`
  expansion) is **deliberately not supported** — the daemon has no way
  to know `$HOME` on the remote machine, so it cannot expand a bare
  session name into an absolute path there. Always write the full
  `remote_socket` path for named remote sessions; do not add a
  `session` key to a `kind = "remote"` target.

`herddeck doctor` verifies each remote target two ways: an SSH
reachability pre-check (`ssh -o BatchMode=yes <host> true`, catching
auth/host-key/DNS problems before any tunnel is attempted) and, once
the local tunnel socket exists, a `ping` probe sent through it —
reporting the remote herdr's version and protocol, or failing with the
underlying error if nothing (or an error) comes back.

#### Linux remotes

A Linux herdr server works identically — the protocol, the tunnel, and
the statusline path are OS-independent. Only the paths differ:

- `remote_socket` is that box's absolute path, typically
  `/home/<user>/.config/herdr/herdr.sock` (herdr honors
  `XDG_CONFIG_HOME`, so confirm with `herdr status` **on the remote**
  rather than assuming).
- Install the same herdr version on both ends. The daemon's tunnel does
  **not** sync binaries — only a human `herdr --remote` attach does —
  so a rarely-attached box can drift; a protocol mismatch degrades that
  target to a warning instead of failing silently, and `herddeck
  doctor` reports the remote's version per target.
- Distro sshd configs occasionally set `AllowStreamLocalForwarding no`;
  if the tunnel establishes but every request fails, that is the first
  thing to check (the error names the socket path since the daemon
  drains ssh's stderr).

See the Phase 3 notes in `docs/plans/2026-08-06-master-plan.md` for the
full verification checklist (network-drop recovery, protocol-mismatch
handling, etc.).
