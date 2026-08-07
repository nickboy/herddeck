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

Development plan and phase results live in `docs/plans/`.

## Status

Phase 0 (bootstrap + live API spike) in progress. Pinned to herdr
protocol 19 (herdr 0.8.0); the daemon pings and compares protocol
versions per target on connect.
