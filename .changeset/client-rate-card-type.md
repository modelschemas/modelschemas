---
'@modelschemas/client': patch
'@modelschemas/rate-card': patch
---

The OpenAPI `RateCard` schemas are now written from the rate-card zod schema (named `RateCard`, `RateCardInput`, `RateCardExpr`, `RateCardTable`, `RateCardPrice`, …), so the client's generated `RateCard` has typed `price` and `tables` and `getModel`'s `pricing` goes to `evaluateCard` after `'price' in pricing`, with no cast. The generated `RateCardInput` is now a union by `kind`, and `RateCardSource`/`RateCardExample` gain descriptions. `rateCardSchema` carries `.meta` ids; validation is unchanged.

`CompactPricing`, `PricingRange`, `ModelReasoning` and `ChatRequestMap` are written from the same zod schemas the server builds them with. `ChatRequestMap.thinking.off` is now typed as an object or null (it was `unknown`); `ModelReasoning` and `PriceBounds` are named types. No served value changes, but the spec now closes these components and the rest of the RateCard family to extra fields (`additionalProperties: false`), as zod writes it for an output schema; a validator built from the spec rejects a field the server adds later.
