---
'@modelschemas/rate-card': patch
---

`evaluateCard` drops a zero usage lever the card does not read (#495).
A non-zero lever the card does not read still throws `unknown-usage-key`.
`POST /v1/estimate` does the same, because it shares `normalizeUsage`.
