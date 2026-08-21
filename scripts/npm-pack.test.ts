import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  assertPublishableManifest,
  assertVersionsMatchTag,
  listPublicPackages,
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

describe('listPublicPackages', () => {
  it('returns the four public workspace packages and no examples', () => {
    const pkgs = listPublicPackages()
    expect(pkgs.map((pkg) => pkg.name).sort()).toEqual([...EXPECTED_NAMES])
    expect(pkgs.every((pkg) => pkg.version === '0.1.0')).toBe(true)
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
    expect(() => assertVersionsMatchTag(pkgs, 'v9.9.9')).toThrow(
      /does not match/,
    )
    expect(() => assertVersionsMatchTag(pkgs, 'v0.1.0')).not.toThrow()
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
  it('rewrites workspace protocol and omits tests', () => {
    const dest = mkdtempSync(join(tmpdir(), 'npm-pack-'))
    try {
      const packed = packAll(publishOrder(listPublicPackages()), dest)
      expect(packed.map((row) => row.pkg.name)).toEqual(
        publishOrder(listPublicPackages()).map((pkg) => pkg.name),
      )
      for (const { pkg, tarball } of packed) {
        const manifest = readPackedManifest(tarball)
        assertPublishableManifest(manifest, tarball)
        const json = JSON.stringify(manifest)
        expect(json).not.toContain('workspace:')
        expect(json).not.toContain('catalog:')
        if (pkg.name === 'modelschemas') {
          expect(json).toContain('"@modelschemas/client":"0.1.0"')
          expect(json).toContain('"@modelschemas/codegen":"0.1.0"')
        }
        if (pkg.name === '@modelschemas/vite') {
          expect(json).toContain('"@modelschemas/codegen":"0.1.0"')
        }
        const entries = packedEntryNames(tarball)
        expect(entries.some((entry) => entry.endsWith('.test.ts'))).toBe(false)
        expect(entries).toContain('package/package.json')
        expect(entries).toContain('package/LICENSE')
      }
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })
})

describe('publish.yml', () => {
  it('is the trusted-publisher workflow: OIDC, stage-only, no npm token', () => {
    const yaml = readFileSync(
      join(import.meta.dirname, '..', '.github', 'workflows', 'publish.yml'),
      'utf8',
    )
    expect(yaml).toMatch(/id-token:\s*write/)
    expect(yaml).toMatch(/environment:\s*npm/)
    const withoutComments = yaml.replace(/^\s*#.*$/gm, '')
    expect(withoutComments).toContain('npm stage publish')
    expect(withoutComments.replaceAll('npm stage publish', '')).not.toContain(
      'npm publish',
    )
    expect(withoutComments).not.toContain('NPM_TOKEN')
    expect(withoutComments).not.toContain('NODE_AUTH_TOKEN')
    expect(withoutComments).not.toContain('bun publish')
  })
})
