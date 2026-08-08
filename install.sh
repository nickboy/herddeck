#!/usr/bin/env bash
# install.sh — one-command HerdDeck install.
#
# bun install → bun test → `herddeck install` (writes + bootstraps the
# daemon's LaunchAgent). No .app bundle, no codesigning, no
# Accessibility/TCC — herdr replaced all of that (see
# docs/CONTRACTS.md, docs/plans/2026-08-06-master-plan.md). The daemon
# just runs as `bun packages/daemon/src/index.ts` under launchd.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "herddeck: bun is required (>= 1.2)." >&2
  echo "  Install with: brew install oven-sh/bun/bun" >&2
  exit 1
fi

echo "herddeck: installing dependencies..."
bun install --frozen-lockfile --cwd "$REPO_ROOT"

echo "herddeck: running test suite..."
(cd "$REPO_ROOT" && bun test)

# The .sdPlugin bundle ships only manifest + profile in git; its bin/
# and images/ are generated, so linking an unbuilt bundle gives Stream
# Deck a plugin with no code path.
echo "herddeck: building Stream Deck plugin bundle..."
(cd "$REPO_ROOT/packages/plugin" && bun run build)

# Put the CLI on PATH — install.sh and the daemon's own output both
# tell you to run `herddeck doctor`, so the command has to exist.
# ~/.local/bin is on PATH ahead of Homebrew in this dotfiles setup; the
# entry point is a shebang script, so a symlink is enough.
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
ln -sf "$REPO_ROOT/packages/cli/src/herddeck.ts" "$BIN_DIR/herddeck"
# The context-donut reporter goes on PATH too: an existing statusline
# feeds the donut by calling it by name, without adopting HerdDeck's
# own statusline (see README "Context donut").
ln -sf "$REPO_ROOT/scripts/herddeck-report-ctx.sh" "$BIN_DIR/herddeck-report-ctx"
# The statusline-free reporter, for machines whose statusline you cannot
# edit (see README "Context donut").
ln -sf "$REPO_ROOT/scripts/herddeck-ctx-scan" "$BIN_DIR/herddeck-ctx-scan"
if command -v herddeck >/dev/null 2>&1; then
  echo "herddeck: CLI linked at $BIN_DIR/herddeck"
else
  echo "herddeck: CLI linked at $BIN_DIR/herddeck (add it to PATH to use \`herddeck\`)"
fi

echo "herddeck: bootstrapping daemon LaunchAgent..."
bun "$REPO_ROOT/packages/cli/src/herddeck.ts" install "$@"

cat <<'EOF'

herddeck installed.

Next steps:
  1. Health check:      herddeck doctor
  2. Inspect targets:   herddeck status
  3. Install the Stream Deck plugin (packages/plugin, SDK v2) — via the
     Elgato Marketplace once published, or for local dev:
       streamdeck link packages/plugin/com.nickboy.herddeck.sdPlugin
     (see packages/plugin/README.md).

EOF
