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
- fal: cacheRead — no chat endpoint publishes a cached-token rate: each Pricing section names input and output tokens only, https://fal.ai/models/fal-ai/bytedance/seed/v2/mini/llms.txt and https://fal.ai/models/openrouter/router/llms.txt, checked 2026-10-06
