import { OPENCODE_CATALOG_URL } from '../opencode-catalog.ts'

import { afterEach, describe, expect, it } from 'vitest'

import {
  OPENCODE_GO_DOCS_MARKDOWN,
  OPENCODE_GO_DOCS_URL,
  OPENCODE_GO_MODELS_URL,
  parseGoDocs,
  provider,
} from './opencode-go.ts'

/** Excerpt of https://opencode.ai/zen/go/v1/models (2026-10-07). */
const LISTING = {
  object: 'list',
  data: ['minimax-m3', 'kimi-k3', 'gpt-6-luna', 'deepseek-v4-pro', 'glm-5'].map(
    (id) => ({
      id,
      object: 'model',
      created: 1791316362,
      owned_by: 'opencode',
    }),
  ),
}

/** Excerpt of https://opencode.ai/docs/go.md (2026-10-07), rows verbatim. */
const DOCS = `OpenCode Go gives you reliable access to popular open coding models, with two monthly plans:

| Plan        | Price         | Included usage                              |
| ----------- | ------------- | ------------------------------------------- |
| **Go**      | **$10/month** | Lower-cost access to the models below       |
| **Go Plus** | **$40/month** | Higher usage limits across the models below |

---

## Usage limits

Usage limits are defined as monthly dollar amounts. The table below shows the
monthly limit for each plan and the token costs for each model. Token pricing is
the same for Go and Go Plus.

Token prices are per 1M tokens.

<Tabs syncKey="go-plan">
  <TabItem label="Go">

    | Model                                   | Input  | Output | Cached Read | Cached Write | Monthly limit                                  |
    | --------------------------------------- | ------ | ------ | ----------- | ------------ | ---------------------------------------------- |
    | Kimi K3                                 | $3.00  | $15.00 | $0.30       | -            | **$15**                                        |
    | MiniMax M3                              | $0.30  | $1.20  | $0.06       | -            | **$60**                                        |
    | DeepSeek V4 Pro (Off-Peak)              | $0.66  | $1.98  | $0.022      | -            | **$15**                                        |
    | DeepSeek V4 Pro (Peak)                  | $1.32  | $3.96  | $0.044      | -            | **$15**                                        |
    | GPT 6 Luna (≤ 272K tokens)              | $0.10  | $0.50  | $0.01       | $0.125       | **$15**                                        |
    | GPT 6 Luna (> 272K tokens)              | $0.20  | $0.75  | $0.02       | $0.25        | **$15**                                        |

  </TabItem>
</Tabs>

---

## Endpoints

You can also access Go models through the following API endpoints.

| Model                        | Model ID                     | Endpoint                                         | AI SDK Package              |
| ---------------------------- | ---------------------------- | ------------------------------------------------ | --------------------------- |
| GPT 6 Luna                   | gpt-6-luna                   | \`https://opencode.ai/zen/go/v1/responses\`        | \`@ai-sdk/openai\`            |
| Kimi K3                      | kimi-k3                      | \`https://opencode.ai/zen/go/v1/chat/completions\` | \`@ai-sdk/openai-compatible\` |
| DeepSeek V4 Pro              | deepseek-v4-pro              | \`https://opencode.ai/zen/go/v1/chat/completions\` | \`@ai-sdk/openai-compatible\` |
| MiniMax M3                   | minimax-m3                   | \`https://opencode.ai/zen/go/v1/messages\`         | \`@ai-sdk/anthropic\`         |

The [model id](/docs/config/#models) in your OpenCode config
uses the format \`opencode-go/<model-id>\`.

---

## Privacy

| Model                        | Model training | Data retention |
| ---------------------------- | -------------- | -------------- |
| Kimi K3                      | Not used       | 0 days         |
`

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(docs: string | Response) {
  const urls: Array<string> = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    if (String(url) === OPENCODE_GO_MODELS_URL) {
      return Promise.resolve(new Response(JSON.stringify(LISTING)))
    }
    if (String(url) === OPENCODE_CATALOG_URL) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            'opencode-go': { models: { synthetic: { id: 'synthetic' } } },
          }),
        ),
      )
    }
    if (String(url) === OPENCODE_GO_DOCS_MARKDOWN) {
      return Promise.resolve(
        typeof docs === 'string' ? new Response(docs) : docs,
      )
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
  return urls
}

describe('opencode-go', () => {
  it('classifies rows by their documented route and leaves prices null', async () => {
    const urls = stubFetch(DOCS)

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    const row = (rawId: string, displayName: string) => ({
      rawId,
      releasedAt: null,
      absent: { releasedAt: 'cleared' },
      pricing: null,
      displayName,
      activity: 'chat',
      factSources: {
        schemaEndpointId: {
          derivation: 'docs-derived',
          sourceUrl: OPENCODE_GO_DOCS_URL,
          path: 'Endpoints',
        },
      },
      schemaEndpointId:
        rawId === 'minimax-m3'
          ? 'v1/messages'
          : rawId === 'gpt-6-luna'
            ? 'v1/responses'
            : 'v1/chat/completions',
    })
    expect(listed.models).toEqual([
      row('minimax-m3', 'MiniMax M3'),
      row('kimi-k3', 'Kimi K3'),
      row('gpt-6-luna', 'GPT 6 Luna'),
      row('deepseek-v4-pro', 'DeepSeek V4 Pro'),
      // Listed, absent from the Endpoints table: stays unclassified.
      {
        rawId: 'glm-5',
        releasedAt: null,
        pricing: null,
        absent: { releasedAt: 'cleared' },
      },
    ])
    expect(provider.bindSyncedRoutesOnly).toBe(true)
    expect(spec.skipped).toBeUndefined()
    expect(spec.specs[0]?.paths?.['/v1/messages']?.post).toMatchObject({
      'x-modelschemas-route-only': true,
    })
    expect(urls.slice(0, 3)).toEqual([
      OPENCODE_GO_MODELS_URL,
      OPENCODE_GO_DOCS_MARKDOWN,
      OPENCODE_CATALOG_URL,
    ])
  })

  it('leaves a row on an unknown route unclassified', () => {
    const docs = DOCS.replace(
      'go/v1/messages`        ',
      'go/v1/systemone`       ',
    )
    const byId = parseGoDocs(docs)
    expect(byId['minimax-m3']).toEqual({
      displayName: 'MiniMax M3',
      activity: null,
      schemaEndpointId: null,
    })
    expect(byId['kimi-k3']?.activity).toBe('chat')
  })

  it.each([
    ['a renamed header', DOCS.replace('| Model ID ', '| Identifier')],
    [
      'an extra column',
      DOCS.replace(
        '| AI SDK Package              |\n',
        '| AI SDK Package              | Notes |\n',
      ),
    ],
    ['a missing section', DOCS.replace('## Endpoints', '## Routes')],
    // The Zen page's routes: a Go row must sit under `/zen/go/`.
    ['a route outside the Go base', DOCS.replaceAll('/zen/go/v1/', '/zen/v1/')],
    ['a duplicate id', DOCS.replace('| kimi-k3        ', '| gpt-6-luna     ')],
    ['no chat route at all', DOCS.replaceAll(/go\/v1\/[a-z/]+`/g, 'go/v1/x`')],
    ['an HTML page', '<!DOCTYPE html><html><body>Not Found</body></html>'],
  ])('throws on %s', (_name, docs) => {
    expect(docs).not.toBe(DOCS)
    expect(() => parseGoDocs(docs)).toThrow(/^opencode-go: /)
  })

  it('throws rather than list unclassified rows when the docs page fails', async () => {
    stubFetch(new Response('gone', { status: 404 }))
    await expect(provider.listModels({})).rejects.toThrow()

    stubFetch('<!DOCTYPE html><html><body>Not Found</body></html>')
    await expect(provider.listModels({})).rejects.toThrow(/returned HTML/)
  })
})
