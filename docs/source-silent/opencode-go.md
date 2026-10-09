# opencode-go exact-model source silence

Checked 2026-10-09 against the native live listing, provider-owned endpoint docs,
and models.dev's own opencode-go catalog. models.dev is used only for OpenCode
Zen/Go, where it is the canonical first-party catalog. SDK package names name
protocols and do not establish another provider's request schema.

Each exception below applies only to its exact native raw id. Populated facts
remain sourced; no request field, reasoning mode, disabling flag, replay
boolean, or billed price is fabricated. Zen's explicit Free token quotes are
sourced zero prices, not source-silent exceptions. Go subscription-accounting
rates remain distinct from billed token prices.

The current chat score does not erase unknown activity on other live ids.
Native live listing: https://opencode.ai/go/v1/models;
endpoint docs: https://opencode.ai/docs/go; canonical own catalog:
https://models.dev/api.json. Checked 2026-10-09. Among activity-null rows,
no own catalog record was published for: `minimax-m2.5`, `kimi-k2.5`, `glm-5.1`, `glm-5`, `deepseek-flash`, `qwen3.5-plus`, `mimo-v2-pro`, `mimo-v2-omni`, `hy3-preview`, `omen-alpha`.
Rows with catalog facts but no sourced chat activity mapping are:
`qwen3.7-max`, `qwen3.6-plus`, `grok-4.5`.
The ten live ids absent from the public catalog remain activity-null. There is
no documented credential-gated source that supplies their missing model facts;
credentials are not substituted for the unavailable public evidence.

- opencode-go/minimax-m3: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/minimax-m3: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/minimax-m3: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/minimax-m3: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/minimax-m2.7: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/minimax-m2.7: reasoning — Own exact-model catalog states reasoning support but publishes an empty reasoning_options list; no mode or disabling semantics are published (#265/#269), https://models.dev/api.json, checked 2026-10-09
- opencode-go/minimax-m2.7: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/minimax-m2.7: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/minimax-m2.7: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/kimi-k3: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/kimi-k3: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/kimi-k2.7-code: reasoning — Own exact-model catalog states reasoning support but publishes an empty reasoning_options list; no mode or disabling semantics are published (#265/#269), https://models.dev/api.json, checked 2026-10-09
- opencode-go/kimi-k2.7-code: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/kimi-k2.7-code: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/kimi-k2.6: reasoning — Own exact-model catalog states reasoning support but publishes an empty reasoning_options list; no mode or disabling semantics are published (#265/#269), https://models.dev/api.json, checked 2026-10-09
- opencode-go/kimi-k2.6: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/kimi-k2.6: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/longcat-2.0: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/longcat-2.0: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/glm-5.2: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/glm-5.2: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/glm-5.3-flash: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/glm-5.3-flash: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/glm-5.3: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/glm-5.3: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/deepseek-v4-pro: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/deepseek-v4-pro: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/deepseek-v4-flash: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/deepseek-v4-flash: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/deepseek-v4.1-flash: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/deepseek-v4.1-flash: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/deepseek-v4-flash-vision-exp: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/deepseek-v4-flash-vision-exp: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/qwen3.8-max: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/qwen3.8-max: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/qwen3.8-max: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/qwen3.8-max: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/qwen3.8-flash: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/qwen3.8-flash: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/qwen3.8-flash: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/qwen3.8-flash: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/qwen3.7-plus: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/qwen3.7-plus: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/qwen3.7-plus: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/qwen3.7-plus: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/mimo-v2.6-pro: reasoning — Own exact-model catalog states reasoning support but publishes an empty reasoning_options list; no mode or disabling semantics are published (#265/#269), https://models.dev/api.json, checked 2026-10-09
- opencode-go/mimo-v2.6-pro: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/mimo-v2.6-pro: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/mimo-v2.6-flash: reasoning — Own exact-model catalog states reasoning support but publishes an empty reasoning_options list; no mode or disabling semantics are published (#265/#269), https://models.dev/api.json, checked 2026-10-09
- opencode-go/mimo-v2.6-flash: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/mimo-v2.6-flash: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/longcat-2.5-preview-free: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/longcat-2.5-preview-free: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/step-5-preview-free: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/step-5-preview-free: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/mimo-v2.5-pro: reasoning — Own exact-model catalog states reasoning support but publishes an empty reasoning_options list; no mode or disabling semantics are published (#265/#269), https://models.dev/api.json, checked 2026-10-09
- opencode-go/mimo-v2.5-pro: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/mimo-v2.5-pro: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/mimo-v2.5: reasoning — Own exact-model catalog states reasoning support but publishes an empty reasoning_options list; no mode or disabling semantics are published (#265/#269), https://models.dev/api.json, checked 2026-10-09
- opencode-go/mimo-v2.5: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/mimo-v2.5: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/hy4-preview: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/hy4-preview: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/hy4-preview: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/hy4-preview: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/hy3: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/hy3: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/hy3: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/hy3: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/claude-haiku-5-5: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/claude-haiku-5-5: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/claude-haiku-5-5: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/claude-haiku-5-5: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/gpt-5.6-luna: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/gpt-5.6-luna: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/gpt-5.6-luna: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/gpt-5.6-luna: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/grok-4.7: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/grok-4.7: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/grok-4.7: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/grok-4.7: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/grok-4.6: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/grok-4.6: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/grok-4.6: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/grok-4.6: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/muse-spark-1.3-contributor: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/muse-spark-1.3-contributor: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/muse-spark-1.3-contributor: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/muse-spark-1.3-contributor: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/muse-spark-1.2-contributor: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/muse-spark-1.2-contributor: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/muse-spark-1.2-contributor: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/muse-spark-1.2-contributor: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/gpt-6-luna: requestMap — Own exact-model catalog publishes no request map; native endpoint docs identify routes/protocol packages without publishing this model’s request-body wire fields (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/gpt-6-luna: replayReasoningContent — Own exact-model catalog publishes no reasoning_content interleaving field; native endpoint docs publish no exact-model replay requirement or exclusion (#265/#270), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/gpt-6-luna: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/gpt-6-luna: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/space-bunny: priced — Go bills a monthly subscription; per-token tables account against the plan usage allowance and are not billed token prices (#265), https://opencode.ai/docs/go, checked 2026-10-09
- opencode-go/space-bunny: cacheRead — Go publishes no billed cached-token price; cached-read rates account against monthly subscription allowance (#265), https://opencode.ai/docs/go, checked 2026-10-09
