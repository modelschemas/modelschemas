import { describe, expect, it } from 'vitest'

import { providerSeeds } from '#/db/seed-providers.ts'

import { ANTHROPIC_SPEC_URL, anthropicProvider } from './anthropic.ts'
import { OPENAI_SPEC_URL } from './openai.ts'
import { sha256Text, stainlessSpecUrlFromStats } from './types.ts'

describe('stainlessSpecUrlFromStats', () => {
  it('reads the openapi_spec_url field', () => {
    expect(
      stainlessSpecUrlFromStats(
        [
          'configured_endpoints: 131',
          'openapi_spec_url: https://example.test/spec.yml',
          'openapi_spec_hash: abc',
        ].join('\n'),
        'anthropic',
      ),
    ).toBe('https://example.test/spec.yml')
  })

  it('throws when the field is missing', () => {
    expect(() =>
      stainlessSpecUrlFromStats('config_hash: abc\n', 'openai'),
    ).toThrow(/openai \.stats\.yml: couldn't find openapi_spec_url/)
  })
})

describe('openai spec source', () => {
  it('seeds the Castiron transformed spec, not the lagging public export', () => {
    const openai = providerSeeds.find((p) => p.id === 'openai')
    expect(openai?.specSourceUrl).toBe(OPENAI_SPEC_URL)
    expect(OPENAI_SPEC_URL).toContain('openai-node')
    expect(OPENAI_SPEC_URL).toContain('openapi.transformed.yml')
  })
})

describe('anthropic fetchSpec (Stainless-bundled mock-spec.json.gz)', () => {
  async function gzip(text: string): Promise<ArrayBuffer> {
    return new Response(
      new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer()
  }

  async function withBody<T>(
    body: BodyInit | null,
    status: number,
    run: () => Promise<T>,
  ): Promise<T> {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) =>
      Promise.resolve(
        String(url) === ANTHROPIC_SPEC_URL
          ? new Response(body, { status })
          : new Response('not found', { status: 404 }),
      )) as typeof fetch
    try {
      return await run()
    } finally {
      globalThis.fetch = original
    }
  }

  it('seeds the bundled spec URL', () => {
    const anthropic = providerSeeds.find((p) => p.id === 'anthropic')
    expect(anthropic?.specSourceUrl).toBe(ANTHROPIC_SPEC_URL)
  })

  it('gunzips the spec and hashes the JSON as specRevision', async () => {
    const json = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Anthropic API' },
      paths: { '/v1/messages': { post: {} } },
    })
    const fetched = await withBody(await gzip(json), 200, () =>
      anthropicProvider.fetchSpec({}),
    )
    expect(fetched.specs[0]?.info?.title).toBe('Anthropic API')
    expect(fetched.sources).toEqual([
      { url: ANTHROPIC_SPEC_URL, hash: await sha256Text(json) },
    ])
    expect(fetched.specRevision).toBe(await sha256Text(json))
  })

  it('throws on 404', async () => {
    await expect(
      withBody('nope', 404, () => anthropicProvider.fetchSpec({})),
    ).rejects.toThrow(/404/)
  })

  it('throws when the bytes are not gzip', async () => {
    await expect(
      withBody('{"openapi":"3.1.0"}', 200, () =>
        anthropicProvider.fetchSpec({}),
      ),
    ).rejects.toThrow(/anthropic: bundled spec .* is not gzipped JSON/)
  })

  it('throws when the document is not OpenAPI', async () => {
    await expect(
      withBody(await gzip('{"hello":"world"}'), 200, () =>
        anthropicProvider.fetchSpec({}),
      ),
    ).rejects.toThrow(/anthropic: bundled spec .* is not OpenAPI/)
  })
})
