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

## Layout

| Package | Purpose |
| --- | --- |
| `packages/protocol` | Committed herdr API schema + generated TS types + NDJSON codec |
| `packages/daemon` | Bun daemon: HerdrClient, SessionRegistry, StateCache, TunnelManager, WS server |
| `packages/plugin` | Stream Deck plugin (SDK v2) |
| `packages/cli` | `herddeck` CLI: install / doctor / status / targets |

Development plan and phase results live in `docs/plans/`. CI checks and
branch protection are documented in `docs/ci.md`.

## Status

v0.1: daemon, plugin, and CLI implemented and live-verified against
herdr 0.8.0 (protocol 19); the daemon pings and compares protocol
versions per target on connect and degrades mismatched targets to a
warning state. Remaining field work: the physical Stream Deck
hardware checklist and real remote-host tunnel validation (master
plan Phases 2-3).

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

HTTPS on purpose: it needs no key setup, and `gh auth setup-git` makes
pushes work non-interactively afterwards. Use the SSH remote only on a
machine whose agent can sign without a prompt.

`install.sh` installs dependencies, runs the test suite, builds the
Stream Deck plugin bundle, and bootstraps the daemon as a `launchd`
LaunchAgent (`bun packages/daemon/src/index.ts`, no `.app` bundle, no
Accessibility/TCC — herdr's socket API replaces all of that; see
`docs/CONTRACTS.md`).

The plugin bundle's `bin/` and `images/` are build outputs, not
committed — link the bundle only after `install.sh` (or
`bun run --cwd packages/plugin build`) has generated them, or Stream
Deck loads a plugin whose `CodePath` does not exist.

The daemon needs a herdr server already running for its local target;
it never starts one itself. Absent socket just means the target shows
offline.

Next, link the Stream Deck plugin:

```bash
streamdeck link packages/plugin/com.nickboy.herddeck.sdPlugin
```

or double-click `packages/plugin/com.nickboy.herddeck.sdPlugin` in
Finder to have Stream Deck.app install it directly. Once published,
the plugin will also be available from the Elgato Marketplace.

Then import the pre-arranged MK.2 layout: double-click
`packages/plugin/com.nickboy.herddeck.sdPlugin/HerdDeck.streamDeckProfile`
(regenerate with `bun packages/plugin/scripts/generateProfile.ts`).
Page 1 mirrors ClaudeDeck's proven layout — five agent slots on top,
answer keys + Wispr Flow + Plan Usage in the middle, arrows/Enter nav
cluster at the bottom. Page 2 holds the herdr-native keys (worktree,
canned prompt, target switcher, slot paging).

Then verify everything is wired up:

```bash
herddeck doctor
```

`doctor` checks herdr is on `PATH` with a matching protocol version, the
local herdr socket exists with sane permissions, the daemon's `/health`
endpoint responds, the `launchd` job is loaded, `~/.herddeck/run/` has
0700 permissions, and (per remote target) an SSH reachability
pre-check plus a `ping` probe through its tunnel socket rather than
trusting the socket file's mere existence — see "Remote targets" below.

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
daemon-side polling is involved. Getting a value in there requires
chaining `scripts/herddeck-statusline.sh` into Claude Code's statusline
so it reports `context_window.percentUsed` to herdr on every turn via
`pane.report_metadata`. Add it to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/absolute/path/to/herddeck/scripts/herddeck-statusline.sh"
  }
}
```

If you already have a statusline command, chain it in front instead of
replacing it — `herddeck-statusline.sh` reads the upstream command's
rendered text off the `display` field of its own stdin JSON and echoes
it verbatim, so it never clobbers a richer statusline. The script relies
on herdr's injected `HERDR_PANE_ID` / `HERDR_SOCKET_PATH` environment
variables and fails silently (never breaks the prompt) when they're
absent. Token metadata doesn't survive a herdr server restart, but the
statusline re-reports every turn, so it self-heals within one turn.

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

See the Phase 3 notes in `docs/plans/2026-08-06-master-plan.md` for the
full verification checklist (network-drop recovery, protocol-mismatch
handling, etc.).
