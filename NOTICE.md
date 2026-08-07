# Third-party attributions

## AgentDeck — Anthropic OAuth usage endpoint schema

The endpoint URL (`https://api.anthropic.com/api/oauth/usage`), the
`Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` header
pair, the response-field resilience strategy, and the Keychain service
name (`Claude Code-credentials`) were identified from AgentDeck's
`bridge/src/usage-api.ts` ([puritysb/AgentDeck](https://github.com/puritysb/AgentDeck),
MIT, Copyright (c) 2025 SerendipityBound). HerdDeck's
`packages/daemon/src/claudeAiFetcher.ts` is inherited from ClaudeDeck's
fresh implementation of that knowledge; no AgentDeck code was copied.

## ClaudeDeck — [nickboy/claudedeck](https://github.com/nickboy/claudedeck)

Same author, MIT. HerdDeck ports ClaudeDeck's plan-usage poller,
claude.ai fetcher, Wispr Flow trigger, Stream Deck plugin structure,
and install/launchd scaffolding.
