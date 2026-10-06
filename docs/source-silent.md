# Source-silent ledger

Facts a provider does not publish in any native source (listing, docs, or
spec). `bun run gap:report` leaves these out of that provider's score and
lists them under `silent`. We never fill them from another catalog.

One entry per list line: `- <provider>: <fact> — <why, with the issue>`.
The fact is a gap-report key (`contextWindow`, `maxOutput`, `modalities`,
`priced`, `cacheRead`, `capabilities`, `reasoning`, `efforts`, `requestMap`,
`endpoint`). Remove an entry when the provider starts publishing the fact.

## Entries

- grok: maxOutput — xAI's spec states only a 128k default, no per-model cap (#75, checked 2026-09-26)
- mistral: maxOutput — Mistral caps output by the context length and publishes no separate limit (#75, checked 2026-09-26)
- minimax: efforts — only MiniMax-M3.1-Flash-Preview takes an effort; the docs say the spec's `reasoning_effort` description says other models ignore the field, https://platform.minimax.io/docs/api-reference/text/api/openapi-chat-openai.json, checked 2026-10-06
