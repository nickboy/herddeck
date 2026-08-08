# Remote-path static review (commit 0ec1d79) — findings + no-remote validation

External static review of the full remote path. Key insight: "remote" here means
"the far side of an ssh streamlocal forward" — localhost is a valid far side, so
~90% of the Phase 3 checklist runs locally against sshd-on-localhost + the
herddeck-test session.

## Verified correct (do not "fix")

- Protocol identity over the tunnel; one request = one SSH channel (not capped
  by MaxSessions, which limits session channels only).
- Per-pane status streams are protocol-imposed (schema requires pane_id; no
  all-panes form) — make-before-break machinery is necessary, not
  over-engineering.
- agent.focus marks done-as-seen remotely; focusTerminal correctly local-only.
- Statusline remote path needs no daemon changes.
- `herdr --remote` human attach may live-handoff the remote server; stream drop
  → full reconnect is the correct recovery (test T6).

## Findings

- **R1 (HIGH, fixed)**: first tunnel-connect failure was permanent until daemon
  restart. launchd starts the daemon before Wi-Fi/VPN is up. Fix: classify
  failures — auth/host-key/config ⇒ no retry; timeout/refused/unreachable/DNS
  (VPN-ambiguous) ⇒ registry-level capped retry (15s→10min). Classification
  surfaced via TargetSnapshot detail.
- **R2 (HIGH, fixed)**: "established" meant the local socket file existed —
  ssh binds before any channel reaches the remote. Remote herdr down / wrong
  absolute path / session socket absent ⇒ tunnel "up" + eternal offline, real
  error (`connect to <path> failed`) invisible in the never-read post-establish
  stderr. Fix: ping-probe THROUGH the socket before declaring established;
  drain stderr for the tunnel lifetime into a ring buffer; probe failure joins
  the transient retry class.
- **R4 (MEDIUM, fixed)**: doctor's tunnel check was file-existence only. Fix:
  ping-probe through each tunnel socket + `ssh -o BatchMode=yes <host> true`
  pre-check per remote target (catches auth/host-key/DNS in one line).
- **R3 (MEDIUM, tracked)**: ≤45s half-open window (ServerAlive 15×3) shows
  stale keys silently. Planned: lastEventAgeMs in /health, optional ping
  watchdog. Issue #6.
- **R5 (LOW, tracked)**: fixed timeouts lack per-target headroom for WAN
  links; add a latency knob only if T10 shows pressure. Issue #7.
- **R6 (LOW, fixed)**: remote named sessions = absolute
  `/home/you/.config/herdr/sessions/<name>/herdr.sock` in remote_socket; the
  session must have been started on the remote at least once. A composing
  `session` field for remotes is impossible without knowing remote $HOME — do
  not add one.
- **R7 (LOW, tracked)**: WS commands against offline targets fail silently;
  add a `command:failed` event so keys can flash red. Issue #8.
- **R8**: (a) unbounded post-establish stderr buffer — subsumed by R2. (b)
  stop() unlink race — harmless, keep force:true. (c) first-attempt handle
  deletion vs re-entry — ownership now documented: R1's registry retry owns
  re-entry.

## Fault-injection matrix (local simulation)

Tier 1 = sshd-on-localhost fake remote (needs Remote Login enabled), targeting
the herddeck-test session socket. Tier 2 = Linux sshd container (adds
protocol-mismatch, netem latency, AllowStreamLocalForwarding=no).

T1 lazy establish · T2 kill ssh → down/retry/recover · T3 half-open (Tier 2
pause) · T4 remote herdr down with tunnel up (R2's named error) · T5 first
connect with sshd down (R1 retry class, recovers) · T6 remote server
restart/handoff mid-stream (reconnect + re-snapshot, seq-checked) · T7 auth
failure (no-retry class; doctor pre-check names it) · T8 protocol mismatch
(Tier 2) · T9 mixed local+remote slots · T10 300ms netem (Tier 2).

Integration scripts live in packages/daemon/test/integration/ behind env
guards, like the live-* scripts. Only the work box's own sshd policy, real
network path, and its herdr binary state genuinely need the field visit.
