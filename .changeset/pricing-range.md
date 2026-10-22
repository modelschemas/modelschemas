---
'@modelschemas/client': patch
---

Price ranges for routed model ids (#406). Model rows gain `pricingRange`
(`PricingRange | null`) and `factSources.pricingRange`: a routed id whose
routes bill different prices has `pricing: null` and a min/max per million
over its routes' published cards, each route named by its own row. It is a
bound, never the billed price. `estimateCost` now returns
`EstimateResult | EstimateRangeResult`: on such a row,
`{ currency, min, max, routes }`, with `min` and `max` naming their route.
