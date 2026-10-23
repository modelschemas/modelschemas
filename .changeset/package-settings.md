---
'@modelschemas/client': patch
'@modelschemas/codegen': patch
'@modelschemas/rate-card': patch
'@modelschemas/vite': patch
'modelschemas': patch
---

The CLI, codegen, and vite declare `engines.node >= 22.18.0` (the CLI
needs `import.meta.main`; on Node 20 it exited without running).
`rateCardSchema` moved from the `@modelschemas/rate-card` root to
`@modelschemas/rate-card/schema`, so the root no longer needs `zod`.
client, codegen, and vite are `sideEffects: false`, and every package
exports `./package.json`.
