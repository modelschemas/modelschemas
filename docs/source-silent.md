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
- opencode: contextWindow — the models list returns only `id`, `object`, `created`, and `owned_by`, and the Zen docs page states no context window, https://opencode.ai/zen/v1/models, checked 2026-10-06
- opencode: maxOutput — neither the models list nor the Zen docs page states an output cap, https://opencode.ai/docs/zen, checked 2026-10-06
- opencode: modalities — neither the models list nor the Zen docs page lists input or output types; the docs' only mention is a billing note that DeepSeek V4 Flash Vision Exp images count as input tokens, https://opencode.ai/docs/zen, checked 2026-10-06
- opencode: capabilities — neither the models list nor the Zen docs page states tool, vision, or structured-output support, https://opencode.ai/docs/zen, checked 2026-10-06
- opencode: requestMap — the Zen docs page names each model's route and AI SDK package and documents no request-body fields, https://opencode.ai/docs/zen, checked 2026-10-06
- opencode: endpoint — OpenCode publishes no OpenAPI document (`/zen/v1/openapi.json` is 404), so no schema exists to bind; the docs name each model's route only, https://opencode.ai/zen/v1/openapi.json, checked 2026-10-06
