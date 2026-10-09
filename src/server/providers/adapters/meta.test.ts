import { afterEach, describe, expect, it } from 'vitest'
import fixtures from '../fixtures/meta-docs.json'
import { provider } from './meta.ts'
import { classifyAndBundle } from '../../ingest/sync.ts'
import {
  META_MODELS,
  META_PRICING,
  META_REFERENCE,
  parseMetaModels,
  parseMetaPricing,
  parseMetaSchemas,
} from '../meta-docs.ts'

const originalFetch = globalThis.fetch
const docs = fixtures as Record<string, string>
function serve(overrides: Record<string, string> = {}) {
  const urls: Array<string> = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    urls.push(url)
    const body = overrides[url] ?? docs[url]
    if (body === undefined) throw new Error(`unexpected source ${url}`)
    return new Response(body)
  }
  return urls
}
afterEach(() => {
  globalThis.fetch = originalFetch
})
describe('Meta native docs', () => {
  it('refreshes all eight hosted IDs and their own tiers without a key', async () => {
    const urls = serve()
    const { models, skipped } = await provider.listModels({})
    expect(skipped).toBeUndefined()
    expect(models).toHaveLength(8)
    const spark = models.find((m) => m.rawId === 'muse-spark-1.3')
    const contributor = models.find(
      (m) => m.rawId === 'muse-spark-1.3-contributor',
    )
    expect(spark).toMatchObject({
      contextWindow: 1048576,
      maxOutput: null,
      reasoning: {
        mandatory: true,
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
    })
    expect(contributor?.reasoning?.efforts).not.toContain('max')
    expect(spark?.pricing).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 1.25 / 1e6,
            output_tokens: 4.25 / 1e6,
            cache_read_tokens: 0.15 / 1e6,
          },
        },
      },
    })
    expect(contributor?.pricing).toMatchObject({
      tables: {
        rate: { base: { input_tokens: 0.1 / 1e6, output_tokens: 0.2 / 1e6 } },
      },
    })
    expect(
      models.find((m) => m.rawId === 'muse-image-1.0')?.pricing,
    ).toMatchObject({ tables: { rate: { base: { generated_images: 0.01 } } } })
    expect(
      models.find((m) => m.rawId === 'muse-voice-transcribe-1.0')?.pricing,
    ).toMatchObject({
      tables: { rate: { base: { audio_seconds: 0.18 / 3600 } } },
    })
    expect(models.find((m) => m.rawId === 'sam-3.1')?.pricing).toMatchObject({
      tables: {
        rate: {
          base: { segmented_images: 2.5 / 1000, video_frames: 0.2 / 1000 },
        },
      },
    })
    expect(
      urls.every((url) => url.startsWith('https://dev.meta.ai/docs/')),
    ).toBe(true)
  })
  it('reads native chat, image and ASR schema resources and POST references', async () => {
    const urls = serve()
    const fetched = await provider.fetchSpec({})
    expect(fetched.skipped).toBeUndefined()
    expect(fetched.specs).toHaveLength(6)
    expect(fetched.sources).toHaveLength(6)
    const bundled = classifyAndBundle(provider, fetched)
    expect(bundled.warnings).toEqual([])
    expect(bundled.endpoints).toHaveLength(6)
    expect(
      bundled.endpoints.every((endpoint) => endpoint.input && endpoint.output),
    ).toBe(true)
    expect(fetched.specs.map((s) => Object.keys(s.paths ?? {}))).toEqual([
      ['/v1/chat/completions'],
      ['/v1/responses'],
      ['/v1/messages'],
      ['/v1/images/generations'],
      ['/v1/images/edits'],
      ['/v1/asr/transcribe'],
    ])
    expect(
      urls.every((url) => url.startsWith('https://dev.meta.ai/docs/')),
    ).toBe(true)
  })
  it('preserves nested array fields, explicit required markers, enums and constraints', () => {
    const schemas = parseMetaSchemas(
      docs[`${META_REFERENCE}chat-completions/schemas`] ?? '',
    )
    expect(schemas['create-chat-completion-request']).toMatchObject({
      required: ['messages', 'model'],
      properties: {
        messages: { type: 'array', minItems: 1 },
        frequency_penalty: { minimum: -2, maximum: 2 },
      },
    })
    expect(schemas['create-chat-completion-response']).toMatchObject({
      properties: {
        choices: {
          items: {
            properties: {
              finish_reason: {
                enum: [
                  'stop',
                  'length',
                  'tool_calls',
                  'content_filter',
                  'function_call',
                ],
              },
            },
          },
        },
      },
    })
    const response = parseMetaSchemas(
      docs[`${META_REFERENCE}responses/schemas`] ?? '',
    )
    expect(
      Object.values(response).some((schema) =>
        JSON.stringify(schema).includes('"x-source-type":null'),
      ),
    ).toBe(true)
  })
  it('preserves native multipart content and marks ASR unpublished fields unknown', async () => {
    serve()
    const fetched = await provider.fetchSpec({})
    const edits = fetched.specs[4]?.paths?.['/v1/images/edits']?.post
    expect(edits?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/edit-image-body-json-param' },
        },
        'multipart/form-data': {
          schema: { $ref: '#/components/schemas/create-image-edit-request' },
        },
      },
    })
    const asr = fetched.specs[5]?.paths?.['/v1/asr/transcribe']?.post
    expect(asr?.requestBody).toMatchObject({
      content: {
        'multipart/form-data': {
          schema: { type: 'object', 'x-source-fields': null },
        },
      },
    })
    expect(
      provider.generationEndpointId?.({
        activity: 'audio',
        rawId: 'muse-voice-transcribe-1.0',
      }),
    ).toBe('v1/asr/transcribe')
  })

  it('fails an empty source instead of removing stored rows', async () => {
    serve({ [META_MODELS]: '<h1>Models</h1>' })
    await expect(provider.listModels({})).rejects.toThrow(
      'model table listed no models',
    )
  })
  it('leaves pricing null when the provider publishes no quote for a newly listed model', () => {
    const models = parseMetaModels(docs[META_MODELS] ?? '')
    models.push({
      rawId: 'synthetic-unsourced',
      providerMetadata: { family: 'Synthetic' },
    })
    const prices = parseMetaPricing(docs[META_PRICING] ?? '', models, {
      url: META_PRICING,
      hash: 'fixture',
      extractedAt: '2026-10-09',
    })
    expect(prices.has('synthetic-unsourced')).toBe(false)
  })
  it('fails unknown types and structurally missing schema cells', () => {
    const source = docs[`${META_REFERENCE}chat-completions/schemas`] ?? ''
    expect(() =>
      parseMetaSchemas(
        source.replace('integer (unixtime)', 'undocumented-primitive'),
      ),
    ).toThrow('unknown schema type')
    expect(() =>
      parseMetaSchemas(source.replace(/<td\b[^>]*>[\s\S]*?<\/td>/, '')),
    ).toThrow('schema field row changed')
  })
  it('rejects malformed published quotes rather than filling old amounts', () => {
    const models = parseMetaModels(docs[META_MODELS] ?? '')
    expect(() =>
      parseMetaPricing(
        (docs[META_PRICING] ?? '').replace('$1.25', '$unknown'),
        models,
        { url: META_PRICING, hash: 'fixture', extractedAt: '2026-10-09' },
      ),
    ).toThrow('unreadable token price')
  })
})
