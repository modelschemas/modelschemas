/**
 * tsc leaves extensionless relative specifiers alone. Node ESM will not
 * load them. After `tsc -p tsconfig.build.json`, rewrite each relative
 * import/export in dist to the emitted `.js` file (a directory becomes
 * `dir/index.js`).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const SPECIFIER = /(?<=(?:from|import)\s*\(?\s*['"])(\.\.?\/[^'"]+)(?=['"])/g

export function rewriteFile(file: string, source: string): string {
  return source.replace(SPECIFIER, (spec) => resolveSpecifier(file, spec))
}

function resolveSpecifier(file: string, spec: string): string {
  if (/\.(?:js|json|node)$/.test(spec)) return spec
  const bare = spec.replace(/\.ts$/, '')
  const abs = resolve(dirname(file), bare)
  if (existsSync(`${abs}.js`)) return `${bare}.js`
  if (existsSync(join(abs, 'index.js'))) return `${bare}/index.js`
  throw new Error(`${file}: cannot resolve ${spec}`)
}

function walk(dir: string): Array<string> {
  const out: Array<string> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

const dist = process.argv[2]
if (!dist) {
  throw new Error('usage: rewrite-dist-imports.ts <dist>')
}
for (const file of walk(dist)) {
  const source = readFileSync(file, 'utf8')
  const next = rewriteFile(file, source)
  if (next !== source) writeFileSync(file, next)
}
