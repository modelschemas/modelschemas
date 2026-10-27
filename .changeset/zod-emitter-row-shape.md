---
'@modelschemas/client': patch
---

The OpenAPI document is now emitted by zod 4.6: nullable fields are written as `type: ["x", "null"]` instead of `anyOf`, tuples carry `items: false` with `minItems`/`maxItems`, and the `date-time` pattern requires seconds. The generated client types are unchanged, as are the served rows; `MODEL_ROW_SHAPE` moves to v7 so `/v1/changes` records the spec change.
