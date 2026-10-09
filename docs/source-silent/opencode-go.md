- opencode-go: priced — Go is billed per month ($10 Go, $40 Go Plus), not per token; the docs' "Usage limits" table quotes per-1M-token rates only to say how usage counts toward each plan's monthly dollar limit, with separate Peak and Off-Peak rates for the DeepSeek models, so no billed per-token price exists, https://opencode.ai/docs/go, checked 2026-10-07
- opencode-go: cacheRead — no billed per-token price exists, so no billed cached-input rate either; the "Cached Read" column of the "Usage limits" table is a rate against the monthly limit, https://opencode.ai/docs/go, checked 2026-10-07

models.dev is OpenCode's own catalog and is used only for OpenCode Zen and Go. Subscription usage-accounting rates are not billed token prices.

The catalog omits some live model ids and does not publish replay fields for every model. Those missing facts remain null and count as completeness gaps; they are not provider-wide source-silent exceptions.
