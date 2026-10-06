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
- replicate: cacheRead — Replicate bills language models per input token and per output token only; no model's billing config or the pricing page states a cached-input price, https://replicate.com/pricing, checked 2026-10-06
- replicate: requestMap — not applicable rather than unpublished: Replicate publishes each model's request fields, but under the prediction's `input` object ("The input schema depends on what model you are running"), which `ChatRequestMap` (an OpenAI-style top-level body) cannot express, https://api.replicate.com/openapi.json, checked 2026-10-06
