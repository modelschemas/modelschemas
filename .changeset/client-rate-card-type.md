---
'@modelschemas/client': patch
---

`getModel`, `listModels` and `listProviderModels` rows type `pricing` as `@modelschemas/rate-card`'s `RateCard | CompactPricing | null`, so a card narrowed with `'price' in pricing` goes to `evaluateCard` with no cast. The client now depends on `@modelschemas/rate-card` (types only; no runtime dependencies of its own).

The client no longer exports the generated `RateCard`, `RateCardInput`, `RateCardExample` and `RateCardSource` types (their `price` and `tables` were `unknown`, so they did not fit `evaluateCard`). Import `RateCard` from `@modelschemas/rate-card`.
