import { OPENCODE_CATALOG_URL } from '../opencode-catalog.ts'

import { afterEach, describe, expect, it } from 'vitest'

import {
  OPENCODE_DOCS_MARKDOWN,
  OPENCODE_DOCS_URL,
  OPENCODE_MODELS_URL,
  parseZenDocs,
  provider,
} from './opencode.ts'

/** Excerpt of https://opencode.ai/zen/v1/models (2026-10-06). */
const LISTING = {
  object: 'list',
  data: [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'gemini-3.1-pro',
    'gpt-5.5',
    'qwen3.8-max',
    'jev-1.13',
    'big-pickle',
  ].map((id) => ({
    id,
    object: 'model',
    created: 1791285710,
    owned_by: 'opencode',
  })),
}

/** Excerpt of https://opencode.ai/docs/zen.md (2026-10-06), rows verbatim. */
const DOCS = `OpenCode Zen is a list of tested and verified models provided by the OpenCode team.

---

## Endpoints

You can also access our models through the following API endpoints.

| Model                           | Model ID                        | Endpoint                                                  | AI SDK Package              |
| ------------------------------- | ------------------------------- | --------------------------------------------------------- | --------------------------- |
| GPT 5.5                         | gpt-5.5                         | \`https://opencode.ai/zen/v1/responses\`                    | \`@ai-sdk/openai\`            |
| Claude Opus 5.5                 | claude-opus-5-5                 | \`https://opencode.ai/zen/v1/messages\`                     | \`@ai-sdk/anthropic\`         |
| Gemini 3.1 Pro                  | gemini-3.1-pro                  | \`https://opencode.ai/zen/v1/models/gemini-3.1-pro\`        | \`@ai-sdk/google\`            |
| Qwen3.8 Max                     | qwen3.8-max                     | \`https://opencode.ai/zen/v1/chat/completions\`             | \`@ai-sdk/openai-compatible\` |
| Jev 1.13                        | jev-1.13                        | \`https://opencode.ai/zen/v1/systemone\`                    | -                           |
| Big Pickle                      | big-pickle                      | \`https://opencode.ai/zen/v1/chat/completions\`             | \`@ai-sdk/openai-compatible\` |

The [model id](/docs/config/#models) in your OpenCode config
uses the format \`opencode/<model-id>\`.

---

## Pricing

We support a pay-as-you-go model. Below are the prices **per 1M tokens**.

| Model                             | Input  | Output  | Cached Read | Cached Write |
| --------------------------------- | ------ | ------- | ----------- | ------------ |
| Big Pickle                        | Free   | Free    | Free        | -            |
| Jev 1.13                          | $0.042 | Free    | -           | -            |
| Qwen3.8 Max                       | $2.00  | $6.00   | $0.25       | $2.50        |
| Claude Opus 5.5                   | $4.00  | $20.00  | $0.20       | $5.00        |
| Gemini 3.1 Pro (≤ 200K tokens)    | $2.00  | $12.00  | $0.20       | -            |
| Gemini 3.1 Pro (> 200K tokens)    | $4.00  | $18.00  | $0.40       | -            |
| GPT 5.5 (≤ 272K tokens)           | $5.00  | $30.00  | $0.50       | -            |
| GPT 5.5 (> 272K tokens)           | $10.00 | $45.00  | $1.00       | -            |

The free models:

- Big Pickle is a stealth model that's free on OpenCode for a limited time.

---

### Deprecated models

| Model              | Deprecation date  |
| ------------------ | ----------------- |
| GPT 5.2 Codex      | July 23, 2026     |

---

## Privacy

All our models are hosted in the US.
`

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function serve(docs: string) {
  globalThis.fetch = ((url: string) => {
    if (String(url) === OPENCODE_MODELS_URL) {
      return Promise.resolve(new Response(JSON.stringify(LISTING)))
    }
    if (String(url) === OPENCODE_CATALOG_URL) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            opencode: { models: { synthetic: { id: 'synthetic' } } },
          }),
        ),
      )
    }
    if (String(url) === OPENCODE_DOCS_MARKDOWN) {
      return Promise.resolve(new Response(docs))
    }
    if (
      String(url).startsWith(
        'https://raw.githubusercontent.com/anomalyco/opencode/dev/',
      )
    )
      return Promise.resolve(
        new Response('export function POST(input: APIEvent) {}'),
      )
    return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
  }) as typeof fetch
}

type Card = { tables: { rate: Record<string, Record<string, number>> } }

describe('opencode', () => {
  it('reads activity and price from the docs tables', async () => {
    serve(DOCS)
    const { models } = await provider.listModels({})
    const byId = Object.fromEntries(models.map((m) => [m.rawId, m]))

    expect(models.map((m) => m.rawId)).toEqual(LISTING.data.map((r) => r.id))

    const opus = byId['claude-opus-5-5']
    expect(opus).toMatchObject({
      displayName: 'Claude Opus 5.5',
      activity: 'chat',
      factSources: {
        pricing: { derivation: 'docs-derived', sourceUrl: OPENCODE_DOCS_URL },
      },
    })
    expect((opus?.pricing as Card).tables.rate).toEqual({
      base: {
        input_tokens: 4 / 1e6,
        output_tokens: 20 / 1e6,
        cache_read_tokens: 0.2 / 1e6,
        cache_write_tokens: 5 / 1e6,
      },
    })

    // `≤ 272K` is the base row and `> 272K` the tier above it.
    const gpt = byId['gpt-5.5']
    expect(gpt).toMatchObject({
      activity: 'chat',
    })
    expect((gpt?.pricing as Card).tables.rate).toEqual({
      base: {
        input_tokens: 5 / 1e6,
        output_tokens: 30 / 1e6,
        cache_read_tokens: 0.5 / 1e6,
      },
      '272000': {
        input_tokens: 10 / 1e6,
        output_tokens: 45 / 1e6,
        cache_read_tokens: 1 / 1e6,
      },
    })

    expect(byId['gemini-3.1-pro']).toMatchObject({
      activity: 'chat',
    })
    expect(byId['qwen3.8-max']).toMatchObject({
      activity: 'chat',
    })

    // System One is not a chat route.
    expect(byId['jev-1.13']).toMatchObject({
      activity: null,
    })
    // An all-free row is not a price.
    expect(byId['big-pickle']).toMatchObject({
      activity: 'chat',
      pricing: null,
    })
    expect(byId['big-pickle']?.factSources?.pricing).toBeUndefined()
    expect(byId['big-pickle']?.factSources?.schemaEndpointId?.sourceUrl).toBe(
      OPENCODE_DOCS_URL,
    )
    // Listed, but in neither docs table.
    expect(byId['claude-sonnet-5-5']).toEqual({
      rawId: 'claude-sonnet-5-5',
      releasedAt: 1791285710,
      pricing: null,
    })

    expect(byId['claude-opus-5-5']?.schemaEndpointId).toBe('v1/messages')
    expect(byId['gpt-5.5']?.schemaEndpointId).toBe('v1/responses')
    expect(byId['gemini-3.1-pro']?.schemaEndpointId).toBe(
      'v1/models/gemini-3.1-pro',
    )
    expect(provider.bindSyncedRoutesOnly).toBe(true)

    expect(
      (await provider.fetchSpec({})).specs[0]?.paths?.['/v1/messages']?.post,
    ).toMatchObject({ 'x-modelschemas-route-only': true })
  })

  it('merges matching native facts and preserves per-model protocol routes', async () => {
    serve(DOCS)
    const fetchDocs = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (String(url) === OPENCODE_CATALOG_URL)
        return Promise.resolve(
          new Response(
            JSON.stringify({
              opencode: {
                models: {
                  'claude-opus-5-5': {
                    id: 'claude-opus-5-5',
                    limit: { context: 1234, output: 234 },
                    tool_call: true,
                    interleaved: { field: 'reasoning_content' },
                    reasoning_options: [{ type: 'budget_tokens', min: 1 }],
                  },
                },
              },
            }),
          ),
        )
      return fetchDocs(url, init)
    }) as typeof fetch
    const model = (await provider.listModels({})).models.find(
      (m) => m.rawId === 'claude-opus-5-5',
    )
    expect(model).toMatchObject({
      contextWindow: 1234,
      maxOutput: 234,
      schemaEndpointId: 'v1/messages',
      reasoning: { mode: 'budget', mandatory: null },
      requestMap: { replayReasoningContent: true },
    })
    expect(model?.factSources?.contextWindow?.sourceUrl).toBe(
      OPENCODE_CATALOG_URL,
    )
    expect(model?.factSources?.pricing?.sourceUrl).toBe(OPENCODE_DOCS_URL)
  })

  it('fails the sync when the native catalog is unavailable or malformed', async () => {
    for (const response of [
      new Response('unavailable', { status: 503 }),
      new Response('{}'),
    ]) {
      serve(DOCS)
      const fetchDocs = globalThis.fetch
      globalThis.fetch = ((url: string, init?: RequestInit) =>
        String(url) === OPENCODE_CATALOG_URL
          ? Promise.resolve(response)
          : fetchDocs(url, init)) as typeof fetch
      await expect(provider.listModels({})).rejects.toThrow()
    }
  })

  it('throws on a page it cannot read', () => {
    expect(() => parseZenDocs('<!DOCTYPE html><html>Not found</html>')).toThrow(
      /HTML/,
    )
    expect(() =>
      parseZenDocs(DOCS.replace('## Endpoints', '## Routes')),
    ).toThrow(/Endpoints table/)
    expect(() =>
      parseZenDocs(DOCS.replace('per 1M tokens', 'per 1K tokens')),
    ).toThrow(/per-1M-token/)
    expect(() =>
      parseZenDocs(DOCS.replace('| Cached Read |', '| Cache Hit   |')),
    ).toThrow(/per-1M-token/)
    expect(() =>
      parseZenDocs(
        DOCS.replace('opencode.ai/zen/v1/messages', 'example.com/v1/messages'),
      ),
    ).toThrow(/unreadable Endpoints row/)
  })

  it('reads the published current discounted price without calculating it', () => {
    const docs = DOCS.replace(
      '| Qwen3.8 Max                       | $2.00  | $6.00   | $0.25       | $2.50        |',
      '| Qwen3.8 Max (50% off) | ~~$4.00~~ $2.00 | ~~$12.00~~ $6.00 | $0.25 | $2.50 |',
    )
    expect(docs).not.toBe(DOCS)
    expect(parseZenDocs(docs)['qwen3.8-max']?.rates?.base.input_tokens).toBe(
      2 / 1e6,
    )
  })

  it('throws on unreadable prices rather than hide failures', () => {
    expect(() => parseZenDocs(DOCS.replace('$20.00 ', '$20/hour'))).toThrow(
      /unreadable Pricing/,
    )
    expect(() =>
      parseZenDocs(DOCS.replace(/\| GPT 5\.5 \(≤ 272K tokens\).*\n/, '')),
    ).toThrow(/unreadable Pricing/)
    expect(() =>
      parseZenDocs(
        DOCS.replace(
          'Gemini 3.1 Pro (> 200K tokens)',
          'Gemini 3.1 Pro (> 400K tokens)',
        ),
      ),
    ).toThrow(/unreadable Pricing/)
    expect(() =>
      parseZenDocs(
        DOCS.replace(
          '| $10.00 | $45.00  | $1.00       |',
          '| $10.00 | $45.00  | -           |',
        ),
      ),
    ).toThrow(/unreadable Pricing/)
  })

  it('leaves undocumented routes unclassified', () => {
    // An unknown route stays unclassified.
    const route = parseZenDocs(
      DOCS.replace(
        'zen/v1/chat/completions`             | `@ai-sdk/openai-compatible` |\n| Jev',
        'zen/v1/embeddings` | - |\n| Jev',
      ),
    )
    expect(route['qwen3.8-max']).toMatchObject({
      activity: null,
    })
  })
})
