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
- perplexity: contextWindow — the FAQ says "Context window size varies by model. See the Agent API models page and the linked provider documentation", and that models page (https://docs.perplexity.ai/docs/agent-api/models.md) and `GET /v1/models` state prices only, https://docs.perplexity.ai/docs/resources/faq.md, checked 2026-10-07
- perplexity: maxOutput — the models page tables hold prices and service tiers only, `GET /v1/models` returns `id`, `owned_by`, and `pricing`, and the spec's `max_output_tokens` has a minimum and no per-model maximum, https://docs.perplexity.ai/docs/agent-api/models.md, checked 2026-10-07
- perplexity: modalities — no page lists input types per model: the files guide says "supported formats and sources depend on the selected model and provider" and names none, and the models page says "Not all third-party models support all features", https://docs.perplexity.ai/docs/agent-api/working-with-files.md, checked 2026-10-07
