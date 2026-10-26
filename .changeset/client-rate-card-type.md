---
'@modelschemas/client': patch
'@modelschemas/rate-card': patch
---

The OpenAPI `RateCard` schemas are now written from the rate-card zod schema (named `RateCard`, `RateCardInput`, `RateCardExpr`, `RateCardTable`, `RateCardPrice`, …), so the client's generated `RateCard` has typed `price` and `tables` and `getModel`'s `pricing` goes to `evaluateCard` after `'price' in pricing`, with no cast. The generated `RateCardInput` is now a union by `kind`, and `RateCardSource`/`RateCardExample` gain descriptions. `rateCardSchema` carries `.meta` ids; validation is unchanged.
