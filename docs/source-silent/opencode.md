- opencode: endpoint — the Zen docs publish per-model routes and SDK packages, but no provider request/response schema to bind; routes remain unbound until a genuine schema is synced, https://opencode.ai/docs/zen, checked 2026-10-09

models.dev is OpenCode's own catalog and is used only for OpenCode Zen and Go. SDK package names describe wire protocols, not model makers; no maker facts are copied.

The catalog omits some live model ids and does not publish replay fields for every model. Those missing facts remain null and count as completeness gaps; they are not provider-wide source-silent exceptions.
