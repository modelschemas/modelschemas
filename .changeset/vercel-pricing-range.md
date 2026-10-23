---
'@modelschemas/client': patch
---

Vercel rows whose price varies by route store a `pricingRange` (#451).
Each route is a Vercel `provider_name` with its compiled card inline, not
a catalog row. `estimateCost` prices those inline cards and names min and
max by provider. Endpoints with `status` other than 0 are omitted and
named on `factSources.pricingRange`. Model row shape is v4.
