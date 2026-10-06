import { afterEach, describe, expect, it } from 'vitest'

import { modelBranchSchemas, walkRequestSchema } from '../fact-sources.ts'
import specFixture from '../fixtures/moonshotai-cn-openapi.json' with { type: 'json' }
import type { OpenApiDocument } from '../types.ts'
import {
  MOONSHOT_CN_OPENAPI_URL,
  MOONSHOT_CN_PRICING_URL,
  moonshotCnChatFacts,
  provider,
} from './moonshotai-cn.ts'

/** Excerpt of platform.kimi.com/docs/pricing/chat.md (2026-10-06). Prices are yuan. */
const PRICING = `
rows={[
["kimi-k3", "1M tokens", "¥20.00", "¥40.00", "¥2.00", "¥20.00", "¥100.00", "1,048,576 tokens"],
]}
rows={[
["kimi-k2.7-code", "1M tokens", "¥1.30", "¥6.50", "¥27.00", "262,144 tokens"],
["kimi-k2.7-code-highspeed", "1M tokens", "¥2.60", "¥13.00", "¥54.00", "262,144 tokens"],
["kimi-k2.6", "1M tokens", "¥1.10", "¥6.50", "¥27.00", "262,144 tokens"],
["kimi-unmapped", "1M tokens", "¥1.00", "¥2.00", "¥3.00", "8,192 tokens"],
]}
`

/** Chat path and its schema closure from platform.kimi.com/docs/openapi.json (2026-10-06). */
const SPEC = specFixture as OpenApiDocument

function mutated(edit: (spec: OpenApiDocument) => void): OpenApiDocument {
  const copy = structuredClone(SPEC)
  edit(copy)
  return copy
}

const originalFetch = globalThis.fetch

function stubFetch(spec: string): Array<string> {
  const urls: Array<string> = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    if (String(url) === MOONSHOT_CN_PRICING_URL) {
      return Promise.resolve(new Response(PRICING))
    }
    if (String(url) === MOONSHOT_CN_OPENAPI_URL) {
      return Promise.resolve(new Response(spec))
    }
    return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
  }) as typeof fetch
  return urls
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('moonshotCnChatFacts', () => {
  it('reads each model from its own branch of the chat union', () => {
    const facts = moonshotCnChatFacts(SPEC, 'h')
    expect(Object.keys(facts)).toEqual([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
    ])
    expect(facts['kimi-k3']).toMatchObject({
      activity: 'chat',
      reasoning: {
        mode: 'effort',
        mandatory: true,
        efforts: ['low', 'high', 'max'],
      },
      maxOutput: 1048576,
      modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    })
    expect(facts['kimi-k3']?.factSources.reasoning).toEqual({
      derivation: 'upstream-spec',
      sourceUrl: MOONSHOT_CN_OPENAPI_URL,
      sourceHash: 'h',
      path: '/components/schemas/KimiK3ChatRequest/properties/reasoning_effort',
    })
    // The K2 schemas take an on/off `thinking` and state no output cap.
    for (const id of ['kimi-k2.7-code', 'kimi-k2.6']) {
      expect(facts[id]?.reasoning).toBeUndefined()
      expect(facts[id]?.factSources.reasoning?.path).toBe('silent')
      expect(facts[id]?.maxOutput).toBeUndefined()
      expect(facts[id]?.modalities).toEqual({
        input: ['text', 'image', 'video'],
        output: ['text'],
      })
    }
  })

  it('stores no cap when the sentence is reworded or names another model', () => {
    const reworded = mutated((spec) => {
      const common = spec.components?.schemas?.ChatRequestCommon as {
        properties: { max_completion_tokens: { description: string } }
      }
      common.properties.max_completion_tokens.description =
        'Kimi K3 默认 131072，上限 1048576。'
    })
    expect(moonshotCnChatFacts(reworded, 'h')['kimi-k3']?.maxOutput).toBe(
      undefined,
    )
    const other = mutated((spec) => {
      const common = spec.components?.schemas?.ChatRequestCommon as {
        properties: { max_completion_tokens: { description: string } }
      }
      common.properties.max_completion_tokens.description =
        'Kimi K4 默认为 131072，最大可设置为 1048576。'
    })
    expect(moonshotCnChatFacts(other, 'h')['kimi-k3']?.maxOutput).toBe(
      undefined,
    )
  })

  it('throws on another host’s spec or a chat body that is not a model union', () => {
    expect(() =>
      moonshotCnChatFacts(
        mutated((spec) => {
          spec.servers = [{ url: 'https://api.moonshot.ai' }]
        }),
        'h',
      ),
    ).toThrow(/spec server/)
    expect(() =>
      moonshotCnChatFacts(
        mutated((spec) => {
          const post = spec.paths?.['/v1/chat/completions']?.post as {
            requestBody: { content: Record<string, { schema: unknown }> }
          }
          post.requestBody.content['application/json'] = {
            schema: { $ref: '#/components/schemas/ChatRequestBase' },
          }
        }),
        'h',
      ),
    ).toThrow(/per-model union/)
  })
})

describe('moonshotai-cn', () => {
  it('lists chat rows with spec facts and does not store yuan as USD', async () => {
    const urls = stubFetch(JSON.stringify(SPEC))
    const { models } = await provider.listModels({})

    expect(urls).toEqual([MOONSHOT_CN_PRICING_URL, MOONSHOT_CN_OPENAPI_URL])
    expect(models.map((model) => model.rawId)).toEqual([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
      'kimi-unmapped',
    ])
    expect(models[0]).toMatchObject({
      rawId: 'kimi-k3',
      activity: 'chat',
      contextWindow: 1048576,
      maxOutput: 1048576,
      pricing: null,
    })
    expect(models[0]?.factSources?.contextWindow).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: MOONSHOT_CN_PRICING_URL,
    })
    expect(models.every((model) => model.pricing === null)).toBe(true)
    // A priced id the chat spec does not map stays unclassified.
    expect(models[4]?.activity).toBeUndefined()
    expect(models[4]?.contextWindow).toBe(8192)
  })

  it('syncs the published spec and binds chat rows to its chat route', async () => {
    stubFetch(JSON.stringify(SPEC))
    const spec = await provider.fetchSpec({})
    expect(spec.skipped).toBeUndefined()
    expect(spec.sources[0]?.url).toBe(MOONSHOT_CN_OPENAPI_URL)
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/files', {})).toBeNull()
    expect(
      provider.generationEndpointId?.({ rawId: 'kimi-k3', activity: 'chat' }),
    ).toBe('v1/chat/completions')
  })

  it('rejects a 200 that is a docs page, not the spec', async () => {
    stubFetch('<!doctype html><html><body>快速开始</body></html>')
    await expect(provider.fetchSpec({})).rejects.toThrow()
    await expect(provider.listModels({})).rejects.toThrow()
  })
})

describe('modelBranchSchemas', () => {
  it('walks one model’s branch, not the whole union', () => {
    const schemas = SPEC.components?.schemas ?? {}
    const body = SPEC.paths?.['/v1/chat/completions']?.post?.requestBody as {
      content: Record<string, { schema: Record<string, unknown> }>
    }
    // The stored shape: refs under `$defs`, the mapping left as published.
    const bundled: unknown = JSON.parse(
      JSON.stringify({
        ...body.content['application/json']?.schema,
        $defs: schemas,
      }).replaceAll('"$ref":"#/components/schemas/', '"$ref":"#/$defs/'),
    )
    const meta = { derivation: 'upstream-spec', endpointId: 'x' } as const
    const flags = Object.fromEntries(
      modelBranchSchemas(bundled).map(([rawId, branch]) => [
        rawId,
        walkRequestSchema(branch, meta)?.flags ?? [],
      ]),
    )
    expect(flags['kimi-k3']).toContain('reasoning_effort')
    expect(flags['kimi-k3']).not.toContain('reasoning')
    expect(flags['kimi-k2.6']).toContain('reasoning')
    expect(flags['kimi-k2.6']).not.toContain('reasoning_effort')
    expect(flags['kimi-k2.6']).toEqual(
      expect.arrayContaining(['tools', 'tool_choice', 'structured_outputs']),
    )
    expect(walkRequestSchema(bundled, meta)?.flags).toEqual(
      expect.arrayContaining(['reasoning', 'reasoning_effort']),
    )
    expect(modelBranchSchemas({ properties: { model: {} } })).toEqual([])
  })
})
