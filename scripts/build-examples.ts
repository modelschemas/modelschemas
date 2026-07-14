// Builds each example as a static SPA and copies its client output into the
// main build's asset directory, so the deployed worker serves them at
// modelschemas.com/examples/<name>/ (issue #3). Runs as part of `bun run
// build`, after vite build — the main build wipes dist/, so order matters.
// The SPA shell prerenders as _shell.html; it is
// renamed to index.html so Workers static assets serve it at the directory
// path (each example is a single route, so no SPA fallback is needed).
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = join(import.meta.dirname, '..')
const examples = ['schema-studio', 'image-dimensions', 'video-composer']

const targetRoot = join(root, 'dist', 'client', 'examples')
if (!existsSync(join(root, 'dist', 'client'))) {
  console.error('dist/client missing — run `bun run build` first')
  process.exit(1)
}
rmSync(targetRoot, { recursive: true, force: true })

for (const name of examples) {
  const dir = join(root, 'examples', name)
  const result = spawnSync('bun', ['run', 'build'], {
    cwd: dir,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error(`examples/${name}: build failed`)
    process.exit(result.status ?? 1)
  }
  const client = join(dir, 'dist', 'client')
  const shell = join(client, '_shell.html')
  if (!existsSync(shell)) {
    console.error(`examples/${name}: expected SPA shell at ${shell}`)
    process.exit(1)
  }
  renameSync(shell, join(client, 'index.html'))
  cpSync(client, join(targetRoot, name), { recursive: true })
  console.log(`examples/${name} -> dist/client/examples/${name}`)
}
