// The hosted flavor (CLOUDFLARE_ENV=modelschemas) serves this app at
// modelschemas.com/examples/image-dimensions/, so client asset URLs carry
// that prefix (vite `base`) — but Workers static assets map URL paths
// directly onto the asset directory layout, and vite does not nest its
// output under `base`. Mirror the URL space by moving the client output
// into the prefix directory. No-op for standalone builds (base "/").
import { mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

if (process.env.CLOUDFLARE_ENV === 'modelschemas') {
  const client = join(import.meta.dirname, '..', 'dist', 'client')
  const nested = join(client, 'examples', 'image-dimensions')
  mkdirSync(nested, { recursive: true })
  for (const entry of readdirSync(client)) {
    // .assetsignore configures the asset upload and must stay at the root.
    if (entry === 'examples' || entry === '.assetsignore') continue
    renameSync(join(client, entry), join(nested, entry))
  }
  console.log('nested client assets under /examples/image-dimensions/')
}
