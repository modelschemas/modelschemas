---
'@modelschemas/client': patch
'@modelschemas/codegen': patch
'@modelschemas/vite': patch
'modelschemas': patch
---

Publish built JavaScript. Each package ships `dist/*.js` and `dist/*.d.ts`.
`exports` and `main` point at `dist/`, and the CLI bin is the built file
with a Node shebang. Plain Node can import the libraries and run
`modelschemas --help` with no TypeScript loader.
