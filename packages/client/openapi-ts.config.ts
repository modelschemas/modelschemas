import { defineConfig } from '@hey-api/openapi-ts'

// Generation input is the emitted spec at the repo root (bun run
// openapi:emit). Output is committed; CI fails when it drifts from the spec
// (bun run check:client).
export default defineConfig({
  input: '../../openapi.json',
  output: { path: 'src/generated', format: 'prettier' },
  plugins: ['@hey-api/client-fetch', '@hey-api/typescript', '@hey-api/sdk'],
})
