import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertPublishableManifest,
  assertVersionsMatchTag,
  listPublicPackages,
  main,
  packAll,
  packedEntryNames,
  publishOrder,
  readPackedManifest,
  tarballFileName,
  versionFromTag,
} from './npm-pack.ts'

const EXPECTED_NAMES = [
  '@modelschemas/client',
  '@modelschemas/codegen',
  '@modelschemas/vite',
  'modelschemas',
] as const

function sharedVersion(): string {
  const pkgs = listPublicPackages()
  const versions = new Set(pkgs.map((pkg) => pkg.version))
  expect(versions.size).toBe(1)
  const version = pkgs[0]?.version
  if (version === undefined) throw new Error('no public packages')
  return version
}

describe('listPublicPackages', () => {
  it('returns the four public workspace packages at one shared version', () => {
    const pkgs = listPublicPackages()
    expect(pkgs.map((pkg) => pkg.name).sort()).toEqual([...EXPECTED_NAMES])
    expect(new Set(pkgs.map((pkg) => pkg.version)).size).toBe(1)
  })
})

describe('publishOrder', () => {
  it('puts packages with no workspace deps before their dependents', () => {
    const ordered = publishOrder(listPublicPackages()).map((pkg) => pkg.name)
    expect(ordered.indexOf('@modelschemas/client')).toBeLessThan(
      ordered.indexOf('modelschemas'),
    )
    expect(ordered.indexOf('@modelschemas/codegen')).toBeLessThan(
      ordered.indexOf('modelschemas'),
    )
    expect(ordered.indexOf('@modelschemas/codegen')).toBeLessThan(
      ordered.indexOf('@modelschemas/vite'),
    )
  })

  it('throws on a workspace dependency cycle', () => {
    expect(() =>
      publishOrder([
        {
          name: 'a',
          version: '1.0.0',
          dir: '/tmp/a',
          dependencies: { b: 'workspace:*' },
        },
        {
          name: 'b',
          version: '1.0.0',
          dir: '/tmp/b',
          dependencies: { a: 'workspace:*' },
        },
      ]),
    ).toThrow(/workspace dependency cycle/)
  })
})

describe('tarballFileName / versionFromTag', () => {
  it('turns scoped names into slash-free tarball filenames', () => {
    expect(tarballFileName('@modelschemas/client', '0.1.0')).toBe(
      'modelschemas-client-0.1.0.tgz',
    )
    expect(tarballFileName('modelschemas', '0.1.0')).toBe(
      'modelschemas-0.1.0.tgz',
    )
  })

  it('parses v-prefixed semver tags only', () => {
    expect(versionFromTag('v0.1.0')).toBe('0.1.0')
    expect(versionFromTag('refs/tags/v1.2.3-rc.1')).toBe('1.2.3-rc.1')
    expect(versionFromTag('0.1.0')).toBeUndefined()
    expect(versionFromTag('vnext')).toBeUndefined()
  })

  it('rejects a tag that does not match package versions', () => {
    const pkgs = listPublicPackages()
    const version = sharedVersion()
    expect(() => assertVersionsMatchTag(pkgs, 'v9.9.9')).toThrow(
      /does not match/,
    )
    expect(() => assertVersionsMatchTag(pkgs, `v${version}`)).not.toThrow()
    expect(() =>
      assertVersionsMatchTag(
        [
          { name: 'ok', version: '0.2.0', dir: '/tmp', dependencies: {} },
          {
            name: 'modelschemas',
            version: '0.1.0',
            dir: '/tmp',
            dependencies: {},
          },
        ],
        'v0.2.0',
      ),
    ).toThrow(/modelschemas@0.1.0/)
  })
})

describe('main', () => {
  it('refuses --tag / RELEASE_TAG that do not match manifests', () => {
    expect(() => main(['--tag', 'v9.9.9'])).toThrow(/does not match/)
    const prev = process.env.RELEASE_TAG
    process.env.RELEASE_TAG = 'v9.9.9'
    try {
      expect(() => main([])).toThrow(/does not match/)
    } finally {
      if (prev === undefined) delete process.env.RELEASE_TAG
      else process.env.RELEASE_TAG = prev
    }
  })
})

describe('assertPublishableManifest', () => {
  it('rejects workspace: and catalog: specs', () => {
    expect(() =>
      assertPublishableManifest(
        {
          name: 'x',
          version: '1.0.0',
          dependencies: { '@modelschemas/client': 'workspace:*' },
        },
        'test',
      ),
    ).toThrow(/workspace:\*/)
  })
})

describe('packAll', () => {
  it('rewrites workspace protocol, omits tests, and resolves relative dest from cwd', () => {
    const dest = join('dist', 'npm-pack-test')
    const abs = resolve(dest)
    try {
      const packed = packAll(publishOrder(listPublicPackages()), dest)
      expect(packed.map((row) => row.pkg.name)).toEqual(
        publishOrder(listPublicPackages()).map((pkg) => pkg.name),
      )
      const version = sharedVersion()
      for (const { pkg, tarball } of packed) {
        expect(tarball.startsWith(`${abs}${sep}`)).toBe(true)
        expect(tarball.includes(`${sep}packages${sep}`)).toBe(false)
        expect(existsSync(tarball)).toBe(true)
        const manifest = readPackedManifest(tarball)
        assertPublishableManifest(manifest, tarball)
        const json = JSON.stringify(manifest)
        expect(json).not.toContain('workspace:')
        expect(json).not.toContain('catalog:')
        if (pkg.name === 'modelschemas') {
          expect(json).toContain(`"@modelschemas/client":"${version}"`)
          expect(json).toContain(`"@modelschemas/codegen":"${version}"`)
        }
        if (pkg.name === '@modelschemas/vite') {
          expect(json).toContain(`"@modelschemas/codegen":"${version}"`)
        }
        const entries = packedEntryNames(tarball)
        expect(entries.some((entry) => entry.endsWith('.test.ts'))).toBe(false)
        expect(entries).toContain('package/package.json')
        expect(entries).toContain('package/LICENSE')
        expect(entries).toContain('package/src/index.ts')
      }
    } finally {
      rmSync(abs, { recursive: true, force: true })
    }
  })
})

describe('publish.yml', () => {
  it('is the trusted-publisher workflow: OIDC, stage-only, no npm token', () => {
    const yaml = readFileSync(
      join(import.meta.dirname, '..', '.github', 'workflows', 'publish.yml'),
      'utf8',
    )
    const withoutComments = yaml.replace(/^\s*#.*$/gm, '')
    expect(withoutComments).toMatch(/id-token:\s*write/)
    expect(withoutComments).toMatch(/environment:\s*npm/)
    expect(withoutComments).toContain('npm stage publish')
    expect(withoutComments.replaceAll('npm stage publish', '')).not.toContain(
      'npm publish',
    )
    expect(withoutComments).not.toContain('NPM_TOKEN')
    expect(withoutComments).not.toContain('NODE_AUTH_TOKEN')
    expect(withoutComments).not.toContain('bun publish')
    expect(withoutComments).toContain('RELEASE_TAG')
    expect(withoutComments).toContain('scripts/npm-pack.ts')
    expect(withoutComments).toMatch(/!inputs\.dry_run/)
    expect(withoutComments).toMatch(/default:\s*true/)
    expect(withoutComments).toContain('npm@11.19.0')
    expect(withoutComments).not.toContain('npm@latest')
    expect(withoutComments).toContain('persist-credentials: false')
    expect(withoutComments).toMatch(/permissions:\s*\{\}/)
  })
})
