/**
 * Pack the public workspace packages for npm.
 *
 * Bun's packer rewrites `workspace:*` / `catalog:` to the concrete
 * versions npm consumers need. Staging and publishing themselves are
 * **not** done here: `npm stage publish` / `npm publish` with OIDC must
 * run from `.github/workflows/publish.yml` so the trusted-publisher
 * match (workflow filename + GitHub environment `npm`) holds and
 * provenance is issued. This script only writes tarballs.
 *
 *   bun scripts/npm-pack.ts                  # dist/npm, then stop
 *   bun scripts/npm-pack.ts --pack-dir /tmp/npm
 *
 * A `vX.Y.Z` tag (or `--tag vX.Y.Z` / `RELEASE_TAG`) must match every
 * public package's version.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export type PublicPackage = {
  name: string
  version: string
  dir: string
  dependencies: Record<string, string>
}

const WORKSPACE_OR_CATALOG = /^(workspace|catalog):/

export function repoRoot(): string {
  return join(import.meta.dirname, '..')
}

export function tarballFileName(name: string, version: string): string {
  const unscoped = name.startsWith('@') ? name.slice(1).replace('/', '-') : name
  return `${unscoped}-${version}.tgz`
}

/** `v0.1.0` or `refs/tags/v0.1.0` → `0.1.0`. Anything else → undefined. */
export function versionFromTag(tag: string): string | undefined {
  const trimmed = tag.replace(/^refs\/tags\//, '')
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) return undefined
  return trimmed.slice(1)
}

export function listPublicPackages(
  packagesDir: string = join(repoRoot(), 'packages'),
): Array<PublicPackage> {
  const pkgs: Array<PublicPackage> = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkgPath = join(packagesDir, entry.name, 'package.json')
    let raw: string
    try {
      raw = readFileSync(pkgPath, 'utf8')
    } catch {
      continue
    }
    const parsed: unknown = JSON.parse(raw)
    const pkg = asPackageJson(parsed, pkgPath)
    if (pkg.private) continue
    pkgs.push({
      name: pkg.name,
      version: pkg.version,
      dir: join(packagesDir, entry.name),
      dependencies: pkg.dependencies,
    })
  }
  pkgs.sort((a, b) => a.name.localeCompare(b.name))
  return pkgs
}

/** Workspace deps first so a laptop bootstrap `npm publish` can go in order. */
export function publishOrder(
  packages: Array<PublicPackage>,
): Array<PublicPackage> {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const remaining = new Set(packages.map((pkg) => pkg.name))
  const ordered: Array<PublicPackage> = []
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) => {
        const pkg = byName.get(name)
        if (!pkg) return false
        return Object.keys(pkg.dependencies).every((dep) => !remaining.has(dep))
      })
      .sort()
    if (ready.length === 0) {
      throw new Error(
        `workspace dependency cycle among ${[...remaining].join(', ')}`,
      )
    }
    for (const name of ready) {
      remaining.delete(name)
      const pkg = byName.get(name)
      if (!pkg) throw new Error(`missing package ${name}`)
      ordered.push(pkg)
    }
  }
  return ordered
}

export function assertVersionsMatchTag(
  packages: Array<PublicPackage>,
  tag: string,
): void {
  const expected = versionFromTag(tag)
  if (expected === undefined) {
    throw new Error(
      `release tag ${JSON.stringify(tag)} is not vMAJOR.MINOR.PATCH`,
    )
  }
  const mismatches = packages.filter((pkg) => pkg.version !== expected)
  if (mismatches.length > 0) {
    const detail = mismatches
      .map((pkg) => `${pkg.name}@${pkg.version}`)
      .join(', ')
    throw new Error(
      `tag v${expected} does not match package versions: ${detail}`,
    )
  }
}

export function assertPublishableManifest(
  manifest: unknown,
  source: string,
): void {
  const pkg = asPackageJson(manifest, source)
  if (pkg.private) {
    throw new Error(`${source}: packed manifest is private`)
  }
  for (const [name, spec] of Object.entries(pkg.dependencies)) {
    if (WORKSPACE_OR_CATALOG.test(spec)) {
      throw new Error(`${source}: ${name} still uses ${spec}`)
    }
  }
}

export function readPackedManifest(tarball: string): unknown {
  const result = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `tar -xOf ${tarball} package/package.json failed: ${result.stderr}`,
    )
  }
  return JSON.parse(result.stdout) as unknown
}

export function packedEntryNames(tarball: string): Array<string> {
  const result = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`tar -tzf ${tarball} failed: ${result.stderr}`)
  }
  return result.stdout.split('\n').filter((line) => line.length > 0)
}

export function packPackage(pkg: PublicPackage, packDir: string): string {
  mkdirSync(packDir, { recursive: true })
  const result = spawnSync(
    'bun',
    ['pm', 'pack', '--destination', packDir, '--quiet'],
    { cwd: pkg.dir, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(
      `bun pm pack ${pkg.name} failed: ${result.stderr || result.stdout}`,
    )
  }
  const tarball = join(packDir, tarballFileName(pkg.name, pkg.version))
  if (!existsSync(tarball)) {
    throw new Error(
      `expected ${tarball} after bun pm pack; stdout=${result.stdout.trim()}`,
    )
  }
  return tarball
}

export function packAll(
  packages: Array<PublicPackage>,
  packDir: string,
): Array<{ pkg: PublicPackage; tarball: string }> {
  rmSync(packDir, { recursive: true, force: true })
  mkdirSync(packDir, { recursive: true })
  const packed: Array<{ pkg: PublicPackage; tarball: string }> = []
  for (const pkg of packages) {
    const tarball = packPackage(pkg, packDir)
    assertPublishableManifest(readPackedManifest(tarball), tarball)
    const entries = packedEntryNames(tarball)
    const tests = entries.filter((entry) => entry.endsWith('.test.ts'))
    if (tests.length > 0) {
      throw new Error(`${tarball} includes test files: ${tests.join(', ')}`)
    }
    packed.push({ pkg, tarball })
  }
  return packed
}

function asPackageJson(
  value: unknown,
  source: string,
): {
  name: string
  version: string
  private: boolean
  dependencies: Record<string, string>
} {
  if (!isRecord(value)) {
    throw new Error(`${source}: package.json is not an object`)
  }
  if (typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error(`${source}: name and version must be strings`)
  }
  return {
    name: value.name,
    version: value.version,
    private: value.private === true,
    dependencies: {
      ...stringRecord(value.dependencies, `${source} dependencies`),
      ...stringRecord(
        value.optionalDependencies,
        `${source} optionalDependencies`,
      ),
      ...stringRecord(value.peerDependencies, `${source} peerDependencies`),
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringRecord(value: unknown, source: string): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`${source}: expected an object`)
  const out: Record<string, string> = {}
  for (const [key, spec] of Object.entries(value)) {
    if (typeof spec !== 'string') {
      throw new Error(`${source}: ${key} is not a string`)
    }
    out[key] = spec
  }
  return out
}

function parseCli(argv: Array<string>): {
  packDir: string | undefined
  tag: string | undefined
} {
  let packDir: string | undefined
  let tag: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') continue
    if (arg === '--pack-dir') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--pack-dir requires a path')
      packDir = value
      i += 1
      continue
    }
    if (arg === '--tag') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('--tag requires a value')
      tag = value
      i += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return { packDir, tag }
}

export function main(argv: Array<string> = process.argv.slice(2)): void {
  const flags = parseCli(argv)
  const packages = publishOrder(listPublicPackages())
  if (packages.length === 0) {
    throw new Error('no public packages under packages/')
  }
  const tag = flags.tag ?? process.env.RELEASE_TAG
  if (tag !== undefined && tag !== '') {
    assertVersionsMatchTag(packages, tag)
  }
  const packDir =
    flags.packDir ?? process.env.NPM_PACK_DIR ?? join(repoRoot(), 'dist', 'npm')
  const packed = packAll(packages, packDir)
  console.log(`packed ${packed.length} packages → ${packDir}\n`)
  for (const { pkg, tarball } of packed) {
    console.log(`  ${pkg.name}@${pkg.version}`)
    console.log(`    ${tarball}`)
  }
  console.log(
    `\nNext: npm stage publish happens in .github/workflows/publish.yml (OIDC).`,
  )
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
