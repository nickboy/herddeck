# HerdDeck: engineering notes

Source material for writing about the project. Everything here is
measured on real hardware against a real account, not reconstructed from
memory — where a number appears, it came out of a log or a live probe.

Built 2026-08-06 to 2026-08-09. 35 commits on `main`, 37 pull requests,
four packages, 504 tests across 32 files. Roughly 7,250 lines of source
against 7,500 lines of test — a ratio that was not a target, but is a
fair summary of where the difficulty lived.

---

## 1. The premise: deleting a codebase by changing the substrate

HerdDeck replaces [ClaudeDeck](https://github.com/nickboy/claudedeck), a
Stream Deck plugin for driving Claude Code sessions from physical keys.
The rebuild exists because the *substrate* changed, not because the old
code was bad.

ClaudeDeck was complicated for a specific reason: Claude Code has no
control API. To know that an agent was blocked, it installed hooks and
dispatched them. To know how full the context window was, it patched the
statusline. To read what a pane was showing, it ran a PTY and kept a ring
buffer. To jump to the right terminal tab, it drove AppleScript, which
meant Accessibility permissions, which meant TCC, which meant
codesigning. To know which project a shell belonged to, it resolved shell
PIDs and watched the projects directory.

[herdr](https://herdr.dev) is a terminal multiplexer built for coding
agents. It already tracks all of that, and exposes it on a Unix socket
speaking NDJSON. Agent lifecycle — `idle` / `working` / `blocked` /
`done` — is a first-class concept in the protocol.

So the rebuild deleted, in order: hook dispatch, the Claude project
watcher, the shell-PID resolver, the PTY runner and its ring buffer,
the statusline auto-patcher, and the AppleScript focus path. With them
went the `.app` bundle, the codesigning step, and every TCC prompt.

Two things came out of that beyond the line count:

**It works for every agent herdr recognises.** Claude Code, Codex,
OpenCode. The old design was Claude-shaped because hooks are
Claude-shaped. The new one asks herdr what is running and gets an answer
that was never Claude-specific.

**Remote came almost free.** herdr's client/server split means the
server holds the state; a remote server speaks the identical protocol.
Forward the socket over SSH and the *same daemon code* drives agents on
another machine:

```text
MacBook  ── Stream Deck + plugin + herddeck daemon ──┐
                                                      │ ssh -N -L (unix socket forward)
Mac mini ── herdr server (agents actually run here) ──┘
```

There was one caveat worth stating precisely, because the obvious guess
is wrong. `herdr --remote` makes the *human* terminal experience a thin
client, but it does **not** expose a local API socket proxying the remote
server — the local `herdr-client.sock` is a TUI attach endpoint. So the
daemon needs its own `ssh -N -L` forward. And the auto-sync that keeps
herdr versions matched only fires on a human `--remote` attach; the
daemon's forward never triggers it. A rarely-attached box can therefore
drift to an older protocol, which is why every target is `ping`ed and
version-checked on connect and degraded to a warning state on mismatch
rather than assumed compatible.

---

## 2. Architecture

```text
Stream Deck plugin ──WebSocket──▶ Bun daemon (launchd)
                                    ├── SessionRegistry   one TargetMonitor per target
                                    ├── TargetMonitor     connect lifecycle, subscriptions
                                    ├── StateCache        pure, keyed by (target, pane_id)
                                    ├── TunnelManager     ssh -N -L for remote targets
                                    └── PlanUsagePoller   Anthropic usage API
```

Four packages: `protocol` (committed herdr schema + generated types +
NDJSON codec), `daemon`, `plugin` (Stream Deck SDK v2), `cli`.

`StateCache` is pure and synchronous — no sockets, no timers — which is
why it carries the majority of the test weight. Everything that can be
decided without I/O is decided there.

### The connect ordering, and why it is not the obvious one

The naive sequence is: snapshot the state, then subscribe to changes.
That loses every transition landing in the gap. The reverse — subscribe,
then snapshot — double-counts.

What actually works:

1. `ping` — protocol check
2. open the lifecycle event stream, **buffering** everything it delivers
3. `session.snapshot` — seed the cache
4. replay the buffer, discarding events the snapshot already reflects
   (`state_change_seq` / `revision`)
5. open the per-pane status stream

Step 4 is the load-bearing one. Buffered events are either already in the
snapshot or strictly newer than it, and the sequence numbers tell you
which. Replayed events carrying no sequence number are dropped whenever
the pane is already cached, and applied only when they describe something
the snapshot missed — a pane created after it was taken.

---

## 3. What the protocol actually does

These are the things you cannot learn by reading a schema.

**One request per connection.** herdr answers the first NDJSON line on a
connection and closes it. `events.subscribe` is the exception: it
converts its connection into a long-lived stream with a fixed
subscription set. So a client that wants to change what it is subscribed
to must open a new stream, which makes subscription changes a
make-before-break problem rather than a mutation.

**Event names are inconsistent.** Lifecycle pushes use underscores
(`pane_created`, with `data.type` repeating the name); status pushes use
dots (`pane.agent_status_changed`). The cache accepts both spellings so
that no caller has to normalise first.

**Container closes do not cascade into pane events.** Closing a workspace
or a tab emits only `workspace_closed` / `tab_closed` — no `pane_closed`
for the panes inside. A cache that only listens for pane events keeps
zombie entries forever.

**`workspace.close` is asynchronous.** The `ok` response returns
immediately; the pane processes wind down for one to two seconds before
`workspace_closed` fires.

**New subscribers get synthetic replay.** A fresh `events.subscribe`
stream receives `pane_created` for panes that already existed. Harmless
under the subscribe-then-snapshot ordering above, but it looks like
corruption if you are not expecting it.

**Per-pane subscriptions are all-or-nothing.** `pane.agent_status_changed`
requires a `pane_id`; there is no wildcard. And one stale id fails the
*entire* batch — which produced the most instructive bug in the project
(§4.2).

**Token metadata has no push path at all.** This one cost the most to
discover and is covered in §4.1.

---

## 4. The bug gallery

Ordered by how much they teach, not by severity.

### 4.1 The frozen donut: two independent bugs stacked

Each Agent Slot key draws a ring showing how full that session's context
window is. It sat at 10% for days, on every session, regardless of
activity.

**First bug: the wrong field name.** The bundled statusline delegate read
`.context_window.percentUsed`. Claude Code emits
`.context_window.used_percentage`. The key detail is *how this failed*:
the script is designed never to break a prompt, so every path falls
through silently. A wrong field name produced no error, no output, and no
report — the extraction simply came back empty, every turn, forever. The
10% was an orphan value written by something else long ago.

**Second bug, and the actual cause: the daemon read tokens exactly
once.** Fixing the field name made agents report a correct percentage
every turn, and the ring still did not move.

Three live probes explain why:

- Reporting metadata to a pane while subscribed to `pane.updated`
  produced **zero events for that pane**. `pane.report_metadata` emits
  nothing.
- `pane.agent_status_changed` carries only `{pane_id, agent_status}` —
  no tokens.
- Tokens are assigned in exactly one place in the cache: the
  `session.snapshot` seed.

So the daemon snapshotted once on connect and every ring froze at
whatever it read at that instant. `pane.updated` *does* carry tokens and
looked like the answer, but it is not one: it fires on scroll offsets and
status flicker — about 20 events in 3.5 seconds from a single active
pane — and, decisively, it does not fire for a metadata report at all. A
pane whose context moved while it sat idle would never be announced.

The fix is a periodic snapshot that merges **tokens only**. Tokens-only
is load-bearing: the timer's snapshot can be older than pushed events
already applied, so re-seeding would let a stale read undo a pane close
that a newer event had already processed. There is a test pinning exactly
that.

**The lesson worth writing down:** the two bugs were independent, and
fixing the visible one first made the invisible one look like the fix had
failed. A cosmetic symptom with two causes is much more confusing than
one with a hard failure.

### 4.2 The subscription flap that fixed itself into a loop

On a busy session the daemon reconnected 24 times in 12 seconds.

Cause: short-lived panes (popups, plugin panes) routinely vanish between
their `pane_created` event and the resubscribe it triggers. herdr fails
an entire subscribe batch when one `pane_id` in it is stale. Tearing down
the connection on that failure rebuilds the *identical doomed batch* on
reconnect — an endless online→connecting flap, where the recovery
mechanism is the thing preventing recovery.

The fix prunes the vanished pane from the cache and retries, bounded.
Reconnects went from 24 in 12 seconds to one.

### 4.3 ControlMaster pollution, in both directions

The remote tunnel is `ssh -N -L <local.sock>:<remote.sock> host`. On a
machine with `ControlMaster` configured — which is to say, most
developers' machines — that tunnel silently joins an existing multiplexed
connection. Two failure modes, and the second is the nastier:

- The tunnel dies when the *unrelated* master connection closes.
- The tunnel's own long-lived connection becomes a master that other
  sessions attach to.

The tunnel now forces `ControlMaster=no ControlPath=none`. A tunnel must
own its connection; borrowing one couples its lifetime to something the
daemon does not control.

This was found by running it on a real machine. No amount of reading the
tunnel code would have surfaced it, because the bug lived in the
interaction between correct code and a personal SSH config.

### 4.4 A self-inflicted race: launchd bootout is asynchronous

`herddeck install` needs to be re-runnable. launchd refuses to bootstrap
an already-loaded label, so the installer boots it out first.

`launchctl bootout` **returns before launchd has finished unloading.**
Bootstrapping immediately after fails on the still-present label with
`Bootstrap failed: 5: Input/output error` — and because the bootout does
eventually complete, the result is that *nothing is loaded*. The daemon
simply disappears until install is run a second time.

The honest part of this story: the bootout was added to make re-running
install idempotent. It fixed that, and traded a loud harmless failure
(bootstrap refusing an already-loaded label) for a silent one that ends
with no service running. The fix polls until the label is really gone and
retries a bootstrap that fails anyway — both bounded, so a genuinely
broken launchd still surfaces its error.

### 4.5 The Enter key that was never wired to anything

The physical Enter key existed, rendered correctly, and did nothing after
a restart.

```ts
const agent = slotManager.getFocusedAgent();
if (!agent) { await ev.action.showAlert(); return; }
```

`focused` starts `undefined` and is only set by pressing an agent slot.
So after any daemon restart or Stream Deck relaunch, Enter, the arrows,
and YES/NO/ALL were all inert — a press flashed an alert and dropped the
keystroke, with nothing to suggest that pressing a slot first was the
missing step.

It failed worst in exactly the situation the hardware exists for:
dictating a prompt into a pane and reaching for a physical Enter key.

herdr already tracks which pane the user is looking at and pushes
`pane_focused` when it moves; the daemon simply never carried the flag.
It does now, and the plugin falls back to it. An explicit press still
wins.

The interesting design constraint was **when not to guess**. Two targets
can each report a focused pane, since each herdr server tracks its own.
Sending Enter to the wrong agent submits someone else's prompt, so the
ambiguous case stays inert. That refusal is tested as carefully as the
feature.

### 4.6 Backoff that answers the wrong question

The Plan Usage key polls Anthropic's usage endpoint. Live:

```text
successes: 1136
HTTP 429:   543
recent ticks: update error update update error update update error update error update update
```

A third of requests rate-limited, and the failures arrived **interleaved,
not in runs**. The existing exponential backoff reset its counter on any
success — so with a 2-in-3 success rate the cadence oscillated between
the 60-second base and one doubling, forever, permanently pinned at the
limit. The log showed `errors=1` **492 times** and `errors=4` five times.

The realisation: consecutive-error backoff answers *"the service is
down."* This was a different question — *"we are asking too often"* — and
no amount of tuning the first answer addresses the second.

Three fixes, in descending order of how much they matter:

1. **A 60-second interval for a key rendering 5-hour and 7-day windows.**
   Those move far slower than that. Now 5 minutes.
2. **An adaptive floor.** Every failure raises it 1.5×; five consecutive
   clean ticks earn one step back down. Back off fast, recover slowly.
3. **Do not poll when nobody is looking.** A daemon with no Stream Deck
   attached was polling anyway — in a two-machine setup that is the herdr
   host spending half the account's request budget rendering a key nobody
   can see. The gate is read per tick, so attaching a deck does not need
   a restart.

There was also a piece of dead scaffolding worth noting: a freshness gate
designed to skip this endpoint when the statusline had recently supplied
the same data had fired **zero times**, because nothing ever populated
the timestamp it read. Machinery built for exactly the problem being
suffered, inert for the whole time it was needed.

### 4.7 A meter that read backwards

The best bug in the project, and the one that arrived last.

Each agent key draws a ring for context fullness. The ring took its
colour from `thresholdColor(pct)` — green under 50%, yellow to 79%, red
above — drawn straight onto the status-coloured background.

Those two palettes are both Catppuccin accents, and they overlap
*exactly*:

```text
THRESHOLD_YELLOW === STATUS_COLOURS.working    // "#f9e2af"
THRESHOLD_RED    === STATUS_COLOURS.blocked    // "#f38ba8"
```

Nine of eighteen ring/background combinations fell under the 3:1
non-text contrast floor, and three were **1.00:1** — the ring and the
background were the same colour.

Invisible would have been the good outcome. What actually happened is
worse: the *unfilled* part of the ring still draws a dark track. So a
`working` agent at 65% showed its filled arc vanish and its empty
35% remain — one dark arc covering just over a third of the circle.

**The key read 35%.** Not blank, not obviously broken. Confidently
wrong, in the two states — `working` and `blocked` — where you are most
likely to be checking whether you need to intervene.

The fix was to delete something rather than add something. Arc length
already encodes the percentage; hue was re-encoding the same number,
coarser, in the one channel the background had already claimed. The ring
now uses the same ink as the text, which resolves the collision and
inherits the text's contrast guarantee for free — so a future palette
edit cannot bring it back.

The general lesson is not about colour. It is that **two independent
signals were competing for one channel on one surface**, and the
symptom of that competition was not "hard to read" but "reads as a
different number."

### 4.8 White text on a yellow key

Text on the agent slot keys was hardcoded `fill="#fff"`. Measured against
the status palette:

| status | background | white | dark ink |
| --- | --- | --- | --- |
| `working` | `#f9e2af` | **1.27:1** | 12.91:1 |
| `done` | `#a6e3a1` | **1.49:1** | 11.03:1 |
| `blocked` | `#f38ba8` | **2.32:1** | 7.08:1 |
| `idle` | `#6c7086` | 4.88:1 | 3.36:1 |
| `offline` | `#45475a` | 9.12:1 | 1.80:1 |

WCAG AA for normal text is 4.5:1. Three of five failed, and `working` —
at 1.27:1, effectively invisible — is the state you most need to read at
a glance.

The fix picks ink per background by contrast ratio rather than swapping
one hardcoded colour for another, because white genuinely *is* correct on
the dark half of the palette. The status colours themselves are
unchanged, so the colour coding still means what it meant. A
parameterised test asserts every status clears AA, so a future palette
edit cannot quietly reintroduce it.

This one is a good reminder that a design system with a documented
palette does not give you contrast for free. Catppuccin Mocha is a
carefully-built palette; nothing in it prevents you from putting its
lightest yellow behind white text.

---

## 5. The recurring pattern

Three separate defects in three days shared one shape: **state inferred
from a derived value rather than read from the component that owns it.**

- herdr's Claude integration installer decides whether it is already
  installed by comparing the **rendered command string** in
  `settings.json`. Rewrite that command to an equivalent portable form
  and the installer no longer recognises its own work, appending a
  duplicate hook. Meanwhile it stamps the script it generates with
  `HERDR_INTEGRATION_ID=claude` — an unambiguous identity it does not
  consult. (Reproduced first-hand in a sandboxed `CLAUDE_CONFIG_DIR`;
  reported upstream.)
- A tab-rename check compared a **cached session name** against the new
  one, rather than the tab's actual label. Once anything else changed the
  label, the check could never repair it — from its viewpoint nothing had
  changed.
- A tab id was trusted from an **inherited environment variable**. A
  session launched from one pane while working in another carried the
  launching pane's id, and renamed a tab it did not own.

In each case the derivative drifts from the thing it stands for, and
nothing notices, because the code is comparing the derivative to itself.
The tell is that the failure is silent and self-consistent: every
component reports success.

---

## 6. Decisions, and what was rejected

Documenting rejected options turned out to matter more than documenting
chosen ones — a rejected option that isn't written down gets proposed
again.

**A model→context-window lookup table.** Rejected. It rots on every model
release, and being silently wrong about a percentage is worse than not
showing one. This is not theoretical: a survey found two shipping tools
reporting context five times too low for exactly this reason — both
normalise the model string without stripping the `[1m]` long-context
suffix, so a 1M session misses the table and lands on a 200K family
entry. A stale table does not fail loudly. It keeps answering, wrongly.

**Scraping `/context` output.** Considered and not taken. It needs no
table and no statusline and is rot-free, because Claude Code computes the
number — but it is brittle to any UI change, and the variant that resumes
a session mutates the thing it is measuring. Recorded because it is the
only known way to get a true window size for a session you did not spawn.

**Subscribing to `pane.updated` for token changes.** Rejected on
measurement: chatty, and it does not fire for the case that matters.

**Guessing a target when focus is ambiguous.** Rejected on consequence.
Sending Enter to the wrong agent submits someone else's prompt.

The one assumption that survives is the context window size: it exists in
exactly one place — the statusline payload's `context_window_size` — and
is absent from the transcript (whose `message.model` drops the `[1m]`
marker), from the session state files, and from every hook payload. So it
is a named constant with an environment override, an overrun clamps to
100% rather than drawing a 216% ring, and the *token count* — which is
always correct — is what the code actually derives. Only the final
division depends on the guess.

---

## 7. Two routes to the same number, and why both exist

The context percentage can be sourced two ways, and they are not
equivalent:

| | statusline | transcript scan |
| --- | --- | --- |
| Percentage | exact, from Claude Code | needs the window constant |
| Coverage | every session | needed two fallbacks to match |
| Cost | none | one polling process |
| Requires | editing that machine's statusline | nothing |

The statusline route is preferred wherever the statusline is yours to
edit. The scan exists for machines where it is not — a company-managed
statusline you must not touch. It reads only files Claude Code already
writes and changes nothing in anyone's configuration.

Run side by side against four live sessions they agreed exactly: 34/34,
43/43, 16/16, and the fourth converging once its turn completed. Getting
there took two fixes that only live data surfaced:

**herdr resolved 3 of 4 Claude panes.** The fourth had
`agent_session: null`. `claude agents --json` maps pid → session id and
herdr knows each pane's processes, so joining them closes the gap — also
with zero configuration.

**That same pane was rate-limited**, and a rate-limited session's
transcript ends in `<synthetic>` records flagged `isApiErrorMessage` with
all-zero usage — six in a row. Reading the newest usage blindly reported
**0% for a session actually at 34%**.

---

## 8. What only running it found

This is the part most worth a blog paragraph.

Every defect above was found by execution. Not one came from reading the
code. The static reviews were genuinely useful — they caught a tilde that
sshd would not expand, an unauthenticated localhost surface, a
first-failure-is-permanent bug in tunnel retry — but the defects that
made the product *not work* were all interaction bugs:

- code interacting with a personal SSH config (ControlMaster)
- code interacting with launchd's asynchrony (bootout)
- code interacting with a rate limiter's actual behaviour (interleaved,
  not runs)
- code interacting with a colour palette (1.27:1)
- code interacting with an account's real API response shape
  (`seven_day_*` siblings a `/weekly/` filter silently dropped)
- code interacting with a rate-limited transcript (`<synthetic>` records)

The common property: each is correct in isolation and wrong in
composition. That is not a category static analysis is good at, and it is
not a category more careful reading fixes. It is the argument for getting
something onto real hardware early, and for treating "it passed review"
as weaker evidence than "it ran."

A smaller corollary, learned the same way: the local gate has to be the
*same* gate. A local `biome check` reported clean while CI's `biome ci`
failed on three lint errors — the two are not interchangeable. There is
now a `bun run verify` that runs the exact CI sequence, and it caught a
formatting error in the very next pull request.

---

## 8a. What review caught that testing did not

§8 argues that execution found what reading missed. An adversarial
review of the contrast and rate-limit work argued the other way, and
was right, so both belong here.

Three findings, and none of them were things a test could have failed
on, because in each case the tests agreed with the code:

**The fix was scoped wrong.** The commit was titled "make slot text
readable" and fixed the text on a key whose dominant graphic is the
ring. The ring was worse — 1.00:1, and reading backwards (§4.7). Worse,
the commit message claimed its new test meant "a future palette change
cannot quietly reintroduce this." It could not — because the test never
covered the ring. A confident claim about a guarantee that was never
made.

**The tests ran against a configuration the same commit had changed.**
The adaptive backoff was tuned and verified at a 60-second base
interval. The same commit moved production to 300 seconds. At 300s the
arithmetic is entirely different: the cap is only 2× the base while one
backoff step is 1.5×, so the *first* failure already exceeded the cap
and the consecutive-error term never affected an outcome again. The
ladder had two rungs. Twelve tests, none at the shipping value.

**The tuning knob was mathematically inert.** Up-steps and down-steps
were the same multiplicative size, so the constant that looked like the
tuning parameter cancelled out of the stability condition entirely. Only
the streak length could affect whether the mechanism converged. A knob
that cannot turn anything is worse than no knob, because someone will
turn it.

The mechanism was deleted rather than tuned. Anthropic states the
correct wait in `Retry-After` — and the fetcher had been capturing that
header all along, formatting it into a log string, and throwing it away.
The replacement obeys the server and is *less* code than the heuristic
it removed.

Two things worth noting about the review itself.

It was asked to attack specific claims, with the arithmetic demanded
rather than the verdict — "work through the failure rate; does it
converge or pin at the cap?" It came back with a Markov chain, a
break-even threshold of 12.9%, and the observation that the convergence
worry was *unfounded* while a different problem was fatal. A reviewer
told to find problems will find some; a reviewer told to check a
specific number sometimes tells you the number is fine and the question
was wrong.

And **the reviewer corrected itself.** Its first pass closed with a
suggestion that wiring one constructor argument would have delivered
more than the whole mechanism. Asked to confirm before that shaped the
fix, it checked, found the channel it depended on does not exist
anywhere in the repo, and led its second response by retracting the
claim. The retraction was the most valuable paragraph in it. A review
that cannot be wrong is not a review.

---

## 9. Numbers

| | |
| --- | --- |
| Built | 2026-08-06 → 2026-08-09 |
| Commits on `main` | 35 |
| Pull requests | 37, all through 7 required CI checks |
| Packages | 4 (`protocol`, `daemon`, `plugin`, `cli`) |
| Tests | 504 across 32 files |
| Source / test lines | ~7,250 / ~7,500 |
| herdr | 0.8.0, protocol 19 |
| Runtime | Bun ≥ 1.2, TypeScript strict, Biome |
| Machines | 2 (laptop with deck, desktop with agents, SSH tunnel) |

CI: `typecheck`, `lint`, `test`, `build`, `gitleaks` (full history),
`shellcheck`, `markdownlint`. `main` is branch-protected with linear
history and squash merges; nothing lands without all seven green.

---

## 10. Still open

- **The context window constant.** See §6. Would be resolved by a
  machine-readable per-model context window that distinguishes the `[1m]`
  variants; Anthropic's `max_input_tokens` is machine-readable but blind
  to them.
- **`herdr integration install` idempotency.** Reproduced, reported
  upstream.
- **Pressing an answer key against a real blocked prompt.** The one
  remaining check that needs a human and a live agent at the same time.
- **Whether the statusline carries plan usage at all.** The poller has a
  freshness gate designed to skip the rate-limited endpoint whenever a
  statusline had recently supplied the same numbers. It has never fired,
  because nothing populates it — and the channel cannot be built until
  someone establishes whether Claude Code's statusline payload contains
  account-scoped rate-limit windows in the first place. The gate now says
  so in its own docstring rather than implying a defence that does not
  exist.
