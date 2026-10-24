# @modelschemas/rate-card

## 0.2.2

### Patch Changes

- 1780348: Format the generated client with oxfmt. No API change.

## 0.2.1

### Patch Changes

- bcbe8d0: Estimate one price per value of a missing choice input (#450).
  `estimateCost` now returns
  `EstimateResult | EstimateRangeResult | EstimateByInputResult`: when the
  call omits exactly one required enum or boolean input with no default
  (BytePlus `pricing_period`), `{ currency, byInput: { input, values } }`
  holds one result per allowed value. `RateCardError` gains `input`, the
  card input the caller did not supply, on `bad-input` "required" and
  `estimate-unavailable`.
- 589f284: **Breaking:** `rateCardSchema` moved from the `@modelschemas/rate-card`
  root to `@modelschemas/rate-card/schema`. The root no longer needs `zod`;
  install it only to import `./schema`.

  **Breaking:** the CLI, codegen, and vite declare `engines.node >= 22.18.0`.
  The CLI needs `import.meta.main`; on Node 20 it exited without running.

  client, codegen, and vite are `sideEffects: false`, and every package
  exports `./package.json`.
