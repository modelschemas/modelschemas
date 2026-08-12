import { describe, expect, it } from 'vitest'

import { classifyAndBundle } from '#/server/ingest/sync.ts'

import { provider } from './voyage.ts'

const SPEC_URL =
  'https://raw.githubusercontent.com/voyage-ai/openapi/main/voyage-openapi.yml'

const FIXTURE_SPEC = `openapi: 3.0.2
info:
  title: Voyage API
  version: "1.1"
paths:
  /embeddings:
    post:
      summary: Text embedding models
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [input, model]
              properties:
                input: { type: string }
                model: { type: string }
      responses:
        "200":
          description: Success
          content:
            application/json:
              schema:
                type: object
  /multimodalembeddings:
    post:
      summary: Multimodal embedding models
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [inputs, model]
              properties:
                inputs: { type: array }
                model: { type: string }
      responses:
        "200":
          description: Success
          content:
            application/json:
              schema:
                type: object
  /rerank:
    post:
      summary: Rerankers
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses:
        "200":
          description: Success
          content:
            application/json:
              schema:
                type: object
`

function withStubbedFetch<T>(
  handler: (url: string, init?: RequestInit) => Response,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch
  return run().finally(() => {
    globalThis.fetch = original
  })
}

describe('voyage adapter', () => {
  it('exports seed metadata for auto-registration', () => {
    expect(provider.id).toBe('voyage')
    expect(provider.displayName).toBe('Voyage AI')
    expect(provider.authEnvVar).toBe('VOYAGE_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe(SPEC_URL)
    expect(provider.modelsEndpoint).toBe('https://api.voyageai.com/v1/models')
  })
})

describe('voyage classify', () => {
  it('maps embedding endpoints and drops rerank/platform', () => {
    expect(provider.classify('/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/multimodalembeddings', {})).toBe('embeddings')
    expect(provider.classify('/contextualizedembeddings', {})).toBe(
      'embeddings',
    )
    expect(provider.classify('/v1/embeddings', {})).toBe('embeddings')
    expect(provider.classify('/rerank', {})).toBeNull()
    expect(provider.classify('/v1/rerank', {})).toBeNull()
    expect(provider.classify('/models', {})).toBeNull()
    expect(provider.classify('/batches', {})).toBeNull()
  })
})

describe('voyage listModels', () => {
  it('skips when VOYAGE_API_KEY is absent', async () => {
    const result = await provider.listModels({})
    expect(result.skipped).toBe('voyage: VOYAGE_API_KEY not set — skipped')
    expect(result.models).toEqual([])
  })

  it('lists models when VOYAGE_API_KEY is set', async () => {
    const result = await withStubbedFetch(
      (url, init) => {
        expect(url).toBe('https://api.voyageai.com/v1/models')
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer test-key',
        )
        return new Response(
          JSON.stringify({
            data: [{ id: 'voyage-4-large', created: 1_737_000_000 }],
          }),
        )
      },
      () => provider.listModels({ VOYAGE_API_KEY: 'test-key' }),
    )

    expect(result.skipped).toBeUndefined()
    expect(result.models).toEqual([
      { rawId: 'voyage-4-large', releasedAt: 1_737_000_000 },
    ])
  })
})

describe('voyage fetchSpec', () => {
  it('fetches the published yaml and classifies generation posts', async () => {
    const fetched = await withStubbedFetch(
      (url) => {
        expect(url).toBe(SPEC_URL)
        return new Response(FIXTURE_SPEC)
      },
      () => provider.fetchSpec({}),
    )

    expect(fetched.outputStrategy).toBe('post-200')
    expect(fetched.sources).toHaveLength(1)
    expect(fetched.sources[0]?.url).toBe(SPEC_URL)
    expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)

    const { endpoints, warnings } = classifyAndBundle(provider, fetched)
    expect(warnings).toEqual([])
    expect(endpoints.map((e) => [e.path, e.activity])).toEqual([
      ['/embeddings', 'embeddings'],
      ['/multimodalembeddings', 'embeddings'],
    ])
    expect(endpoints.every((e) => e.derivation === 'upstream-spec')).toBe(true)
  })
})
