---
'@modelschemas/client': patch
'@modelschemas/codegen': patch
'@modelschemas/rate-card': patch
'@modelschemas/vite': patch
'modelschemas': patch
---

**Breaking:** `rateCardSchema` moved from the `@modelschemas/rate-card`
root to `@modelschemas/rate-card/schema`. The root no longer needs `zod`;
install it only to import `./schema`.

**Breaking:** the CLI, codegen, and vite declare `engines.node >= 22.18.0`.
The CLI needs `import.meta.main`; on Node 20 it exited without running.

client, codegen, and vite are `sideEffects: false`, and every package
exports `./package.json`.
