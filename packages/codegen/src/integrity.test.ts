import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { schemaContentHash, verifyIntegrity } from './integrity.ts'

const SCHEMA = { type: 'object', properties: { model: { type: 'string' } } }
const HASH = schemaContentHash(SCHEMA)
const KEY = 'anthropic/chat/v1/messages#request'

const PROVENANCE = {
  sourceUrl: 'https://example.com/spec.yml',
  sourceHash: 'f'.repeat(64),
  fetchedAt: 1_781_150_000,
  extractorVersion: '1',
}

let outDir: string

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'modelschemas-integrity-'))
  await writeFile(
    join(outDir, '.manifest.json'),
    JSON.stringify({
      version: 1,
      baseUrl: 'https://svc.test',
      selections: ['anthropic/v1/messages#request'],
      types: false,
      optionalStyle: 'exact',
      fetchedAt: 1_781_150_000,
      entries: {
        [KEY]: {
          path: 'anthropic/v1-messages.request.ts',
          contentHash: HASH,
          etag: `"${HASH}"`,
        },
      },
    }),
  )
})

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true })
})

function service(body: unknown, status = 200): typeof fetch {
  return (input) => {
    const { pathname, searchParams } = new URL(String(input))
    expect(pathname).toBe('/v1/schemas/anthropic/chat/v1/messages')
    expect(searchParams.get('kind')).toBe('input')
    expect(searchParams.get('version')).toBe(HASH)
    return Promise.resolve(Response.json(body, { status }))
  }
}

describe('schemaContentHash', () => {
  it('is key-order independent (matches the server contentHash)', () => {
    expect(schemaContentHash({ b: 1, a: { d: [2], c: 3 } })).toBe(
      schemaContentHash({ a: { c: 3, d: [2] }, b: 1 }),
    )
  })
})

describe('verifyIntegrity', () => {
  it('passes when the served schema re-hashes to the pinned address', async () => {
    const result = await verifyIntegrity({
      baseUrl: 'https://svc.test',
      outDir,
      selections: [],
      fetchImpl: service({
        contentHash: HASH,
        schema: SCHEMA,
        provenance: PROVENANCE,
      }),
    })
    expect(result.ok).toBe(true)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]?.provenance).toEqual(PROVENANCE)
  })

  it('fails when served bytes do not match the pinned hash', async () => {
    const result = await verifyIntegrity({
      baseUrl: 'https://svc.test',
      outDir,
      selections: [],
      fetchImpl: service({
        contentHash: HASH, // service *claims* the right hash…
        schema: { type: 'object', tampered: true }, // …but serves other bytes
      }),
    })
    expect(result.ok).toBe(false)
    expect(result.checks[0]?.problem).toContain('mismatch')
  })

  it('fails when the pinned version is gone', async () => {
    const result = await verifyIntegrity({
      baseUrl: 'https://svc.test',
      outDir,
      selections: [],
      fetchImpl: service(
        { error: { code: 'unknown_schema', message: 'gone' } },
        404,
      ),
    })
    expect(result.ok).toBe(false)
    expect(result.checks[0]?.problem).toContain('pinned version')
  })

  it('fails with a remediation problem when the manifest is missing', async () => {
    await rm(join(outDir, '.manifest.json'))
    const result = await verifyIntegrity({
      baseUrl: 'https://svc.test',
      outDir,
      selections: [],
      fetchImpl: () => {
        throw new Error('must not fetch')
      },
    })
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toContain('modelschemas pull')
  })
})
