---
'@modelschemas/client': patch
'@modelschemas/rate-card': patch
---

Estimate one price per value of a missing choice input (#450).
`estimateCost` now returns
`EstimateResult | EstimateRangeResult | EstimateByInputResult`: when the
call omits exactly one required enum or boolean input with no default
(BytePlus `pricing_period`), `{ currency, byInput: { input, values } }`
holds one result per allowed value. `RateCardError` gains `input`, the
card input the caller did not supply, on `bad-input` "required" and
`estimate-unavailable`.
