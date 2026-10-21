import { afterEach, expect, it, vi } from 'vitest'
import {
  classifyOpenCodeRoute,
  documentedRoutes,
  OPENCODE_GO_ROUTE_DOCS_URL,
  OPENCODE_ROUTE_DOCS_URL,
  openCodeRouteSpec,
} from './opencode-routes.ts'

/** inference.mdx excerpt (2026-10-21). */
const ZEN_DOCS = `## Endpoints

| API                     | Path                                                      |
| ----------------------- | --------------------------------------------------------- |
| OpenAI Chat Completions | \`/inference/openai/v1/chat/completions\`                   |
| OpenAI Responses        | \`/inference/openai/v1/responses\`                          |
| Anthropic Messages      | \`/inference/anthropic/v1/messages\`                        |
| Gemini                  | \`/inference/google/v1beta/models/<model>:generateContent\` |

### Gemini

\`\`\`bash
curl -X POST "https://opencode.ai/inference/google/v1beta/models/gemini-3.1-pro:generateContent"
\`\`\`
`

/** go.mdx excerpt (2026-10-21). */
const GO_DOCS = `## Endpoints

| Model  | Model ID | Endpoint                                                       | AI SDK Package              |
| ------ | -------- | -------------------------------------------------------------- | --------------------------- |
| GPT    | gpt      | \`https://opencode.ai/inference/go/openai/v1/responses\`         | \`@ai-sdk/openai\`            |
| Haiku  | haiku    | \`https://opencode.ai/inference/go/anthropic/v1/messages\`       | \`@ai-sdk/anthropic\`         |
| Gemini | gemini   | \`https://opencode.ai/inference/go/google/v1beta/models/gemini\` | \`@ai-sdk/google\`            |

## Privacy

\`https://opencode.ai/inference/go/openai/v1/chat/completions\`
`

const original = globalThis.fetch
afterEach(() => {
  globalThis.fetch = original
})
function serve(text: string) {
  globalThis.fetch = vi.fn(async () => new Response(text))
}
function fetched(): Array<string> {
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
    String(call[0]),
  )
}

it('reads only the Endpoints table, with origins stripped', () => {
  expect([...documentedRoutes(GO_DOCS, 'go')]).toEqual([
    '/inference/go/openai/v1/responses',
    '/inference/go/anthropic/v1/messages',
    '/inference/go/google/v1beta/models/gemini',
  ])
  expect(() => documentedRoutes('# Inference', 'docs')).toThrow(
    'documents no endpoint paths',
  )
})
it('sources Zen protocol paths from the inference docs, with no schema bodies', async () => {
  serve(ZEN_DOCS)
  const result = await openCodeRouteSpec(
    [
      {
        schemaEndpointId: 'inference/openai/v1/chat/completions',
        activity: 'chat',
      },
      { schemaEndpointId: 'inference/openai/v1/responses', activity: 'chat' },
      { schemaEndpointId: 'inference/anthropic/v1/messages', activity: 'chat' },
      {
        schemaEndpointId:
          'inference/google/v1beta/models/gemini:generateContent',
        activity: 'chat',
      },
      { schemaEndpointId: null, activity: null },
    ],
    { url: 'https://models.dev/api.json', text: 'catalog fixture' },
    false,
  )
  expect(Object.keys(result.specs[0]?.paths ?? {})).toEqual([
    '/inference/openai/v1/chat/completions',
    '/inference/openai/v1/responses',
    '/inference/anthropic/v1/messages',
    '/inference/google/v1beta/models/gemini:generateContent',
  ])
  const operation =
    result.specs[0]?.paths?.['/inference/anthropic/v1/messages']?.post ?? {}
  expect(operation).not.toHaveProperty('requestBody')
  expect(operation.responses).toEqual({})
  expect(classifyOpenCodeRoute('/inference/v1/messages', operation)).toBe(
    'chat',
  )
  expect(classifyOpenCodeRoute('/inference/v1/messages', {})).toBeNull()
  expect(fetched()).toEqual([OPENCODE_ROUTE_DOCS_URL])
  const source = operation['x-modelschemas-method-source'] as {
    url: string
    hash: string
  }
  expect(source.url).toBe(OPENCODE_ROUTE_DOCS_URL)
  expect(source.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(result.sources.map((s) => s.url)).toEqual([
    'https://models.dev/api.json',
  ])
})
it('keeps Go ids at v1/<tail> and checks them under /inference/go/<protocol>/', async () => {
  serve(GO_DOCS)
  const result = await openCodeRouteSpec(
    [
      { schemaEndpointId: 'v1/responses', activity: 'chat' },
      { schemaEndpointId: 'v1/messages', activity: 'chat' },
    ],
    { url: 'docs', text: 'docs' },
    true,
  )
  expect(Object.keys(result.specs[0]?.paths ?? {})).toEqual([
    '/v1/responses',
    '/v1/messages',
  ])
  expect(fetched()).toEqual([OPENCODE_GO_ROUTE_DOCS_URL])
})
it.each([
  ['inference/openai/v1/messages', false],
  ['inference/anthropic/v1/chat/completions', false],
  ['inference/go/openai/v1/chat/completions', false],
  ['inference/v1/messages', false],
  ['v1/chat/completions', true],
])('rejects %s, a route the docs do not list', async (id, go) => {
  serve(go ? GO_DOCS : ZEN_DOCS)
  await expect(
    openCodeRouteSpec(
      [{ schemaEndpointId: id, activity: 'chat' }],
      { url: 'docs', text: 'docs' },
      go,
    ),
  ).rejects.toThrow('documents no /inference/')
})
it('rejects a Go id with no protocol tail before it fetches', async () => {
  serve(GO_DOCS)
  await expect(
    openCodeRouteSpec(
      [{ schemaEndpointId: 'v1/embeddings', activity: 'chat' }],
      { url: 'docs', text: 'docs' },
      true,
    ),
  ).rejects.toThrow('opencode-go: v1/embeddings names no native route')
  expect(globalThis.fetch).not.toHaveBeenCalled()
})
it('rejects a failed docs source', async () => {
  globalThis.fetch = vi.fn(async () => new Response('gone', { status: 404 }))
  await expect(
    openCodeRouteSpec(
      [{ schemaEndpointId: 'v1/messages', activity: 'chat' }],
      { url: 'docs', text: 'docs' },
      true,
    ),
  ).rejects.toThrow()
})
