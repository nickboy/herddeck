# CI and Branch Protection

`main` is protected. Every change lands through a PR that passes five
required status checks, then gets squash-merged. This doc is the
source of truth for what those checks run and the exact command to
re-apply branch protection if it's ever dropped or edited by mistake.

## Required checks

Defined in `.github/workflows/ci.yml`, one job each, all on
`ubuntu-latest`:

| Check | Runs |
| --- | --- |
| `typecheck` | `bunx tsc --noEmit` |
| `lint` | `bunx biome ci .` |
| `test` | `bun test` (the whole workspace, every `*.test.ts`) |
| `shellcheck` | `shellcheck -x` over every tracked `*.sh` |
| `markdownlint` | `npx --yes markdownlint-cli` over every tracked `*.md` |

The workflow triggers on every pull request and on push to `main`.
Each job does a fresh `bun install --frozen-lockfile` — there's no
shared cache, so a broken lockfile fails every check the same way.

## Branch protection settings

Applied to `main` via the classic branch-protection API
(`repos/{owner}/{repo}/branches/{branch}/protection`):

- **Strict status checks** (`required_status_checks.strict: true`) —
  a PR branch must be up to date with `main` before merging, not just
  green against the commit it branched from.
- **`enforce_admins: true`** — the checks apply to the repo owner too;
  there's no bypass for administrators.
- **`required_linear_history: true`** — no merge commits on `main`.
  Combined with the repo's merge-button settings (squash and rebase
  merge allowed, plain merge commits are rejected by GitHub once
  linear history is on regardless of what the button offers), every
  PR lands as a single squash commit.
- Force pushes, branch deletion, and creating new refs that skip
  protection are all disabled (`allow_force_pushes`,
  `allow_deletions`, `block_creations` all `false`).

Re-apply the full set with:

```bash
gh api -X PUT repos/nickboy/herddeck/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["typecheck", "lint", "test", "shellcheck", "markdownlint"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON
```

Verify with `gh api repos/nickboy/herddeck/branches/main/protection`.

## What's deliberately not in CI

`packages/daemon/test/integration/*.ts` are live end-to-end tests —
they spawn `DeckServer` + `SessionRegistry` in-process and talk to a
real herdr socket. They need a running herdr session named
`herddeck-test` (`~/.config/herdr/sessions/herddeck-test/herdr.sock`)
and a free port, so they're local-only: run manually with
`bun packages/daemon/test/integration/live-e2e.ts`, never wired into
`ci.yml`. Everything those tests exercise that's feasible to fake also
has a unit-test counterpart under `packages/daemon/src/*.test.ts`
(e.g. `server.test.ts` covers `DeckServer` against a stub
`SessionRegistry`) — that coverage is what CI actually runs.
