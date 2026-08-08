# Phase 3 Results (partial) — Tier-1 fake-remote validation

Run 2026-08-08 against sshd-on-localhost (`Host fakebox → localhost`,
BatchMode key auth) forwarding to the herddeck-test session socket.
Matrix rows refer to docs/plans/2026-08-08-remote-path-review.md.

## Results

| Row | Scenario | Result |
| --- | --- | --- |
| T1 | Lazy establish incl. R2 ping-probe through the forward | ✅ |
| T2 | Kill tunnel ssh → down event → backoff → auto-recovery, monitor back online | ✅ |
| T9-lite | Full herdr protocol (streams+snapshot+per-pane subs) over a real streamlocal forward | ✅ |
| T4 | Remote herdr down, tunnel up | ✅ pre-R2 this was "tunnel green + eternal offline + zero clues"; now fails in seconds with ssh's `channel 1: open failed: connect failed`, full `-L` path mapping in the log, classified transient → registry retry |
| T5/T7 | First-connect with sshd down / auth failure classes | Skipped live (need sudo / key juggling); both classification paths unit-tested |
| T3/T8/T10 | Half-open, protocol-mismatch, latency | Deferred to Tier 2 Linux container (issues #6–#8 track the related fixes) |

## Operational rule (from a live-found incident)

**The tunnel's ssh must always run `ControlMaster=no` +
`ControlPath=none`.** With the user-level `ControlMaster auto` config
the danger is bidirectional: (a) the daemon's forward can mux onto an
interactive session's master and die with that master's
`ControlPersist` timeout; (b) the daemon's ssh can itself BECOME the
master, so later interactive sessions mux onto the daemon's process —
a daemon restart or `stop()` SIGTERM then tears down the user's live
shells. Owning the connection kills both directions. This class of bug
is invisible to any repo-only review — it lives in the interaction
with `~/.ssh/config`.

## Environment notes

- macOS `systemsetup -setremotelogin on` needs Full Disk Access; the
  GUI toggle (or `launchctl load -w .../ssh.plist`) works.
- BatchMode + host-key: `ssh-keyscan` the host once (BatchMode can't
  prompt).
- `~/.ssh/sockets/` must exist for the dotfiles' ControlMaster config
  (fixed in dotfiles bootstrap).
- Loopback fixtures kept for regression reruns: `~/.ssh/herddeck_fake_remote*`,
  one authorized_keys line, `~/.ssh/config.d/99-herddeck-fake-remote.conf`.

## Remaining for the work box (~15 min confirmation)

Its sshd policy (`AllowStreamLocalForwarding`), the real network path,
and its herdr binary/protocol state — everything else is validated.
