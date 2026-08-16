import { describe, expect, it } from 'vitest'

import { classifyAndBundle } from '#/server/ingest/sync.ts'

import { provider, voyageModelsFromSpec } from './voyage.ts'

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
    expect(provider.modelsEndpoint).toBe(SPEC_URL)
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

describe('voyageModelsFromSpec', () => {
  it('collects documented voyage-* ids and drops rerankers', () => {
    const models = voyageModelsFromSpec({
      paths: {
        '/embeddings': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    properties: {
                      model: {
                        type: 'string',
                        description:
                          'Recommended: `voyage-3-large`, `voyage-3`. Also `rerank-2`.',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    })
    expect(models).toEqual([
      { rawId: 'voyage-3', activity: 'embeddings' },
      { rawId: 'voyage-3-large', activity: 'embeddings' },
    ])
  })
})

describe('voyage listModels', () => {
  it('reads the catalog from the published spec, not /v1/models', async () => {
    const urls: Array<string> = []
    const result = await withStubbedFetch(
      (url) => {
        urls.push(url)
        return new Response(`openapi: 3.0.2
info: { title: Voyage API, version: "1.1" }
paths:
  /embeddings:
    post:
      requestBody:
        content:
          application/json:
            schema:
              properties:
                model:
                  type: string
                  description: Recommended \`voyage-3-large\`.
`)
      },
      () => provider.listModels({}),
    )

    expect(urls).toEqual([SPEC_URL])
    expect(result.skipped).toBeUndefined()
    expect(result.models).toEqual([
      { rawId: 'voyage-3-large', activity: 'embeddings' },
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
