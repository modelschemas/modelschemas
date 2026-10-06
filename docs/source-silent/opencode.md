- opencode: contextWindow — the models list returns only `id`, `object`, `created`, and `owned_by`, and the Zen docs page states no context window, https://opencode.ai/zen/v1/models, checked 2026-10-06
- opencode: maxOutput — neither the models list nor the Zen docs page states an output cap, https://opencode.ai/docs/zen, checked 2026-10-06
- opencode: modalities — neither the models list nor the Zen docs page lists input or output types; the docs' only mention is a billing note that DeepSeek V4 Flash Vision Exp images count as input tokens, https://opencode.ai/docs/zen, checked 2026-10-06
- opencode: capabilities — neither the models list nor the Zen docs page states tool, vision, or structured-output support, https://opencode.ai/docs/zen, checked 2026-10-06
- opencode: requestMap — the Zen docs page names each model's route and AI SDK package and documents no request-body fields, https://opencode.ai/docs/zen, checked 2026-10-06
- opencode: endpoint — OpenCode publishes no OpenAPI document (`/zen/v1/openapi.json` is 404), so no schema exists to bind; the docs name each model's route only, https://opencode.ai/zen/v1/openapi.json, checked 2026-10-06

No row has a `sameAs` link to a maker's row for these facts: OpenCode names no maker. `owned_by` is `opencode` on every row, and the Endpoints table's AI SDK package names the wire protocol (`@ai-sdk/anthropic` also serves the Qwen rows, `@ai-sdk/openai` the Grok and Muse Spark rows), checked 2026-10-07.
