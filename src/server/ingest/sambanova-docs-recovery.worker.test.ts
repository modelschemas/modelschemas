import { requestUrl } from '#/lib/text.ts'
import { env } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { getDb } from '../../db/index.ts'
import { provider } from '../providers/adapters/sambanova.ts'
import {
  SAMBANOVA_MODELS_DOCS_URL,
  SAMBANOVA_SPEC_URL,
  SAMBANOVA_TOOLS_DOCS_URL,
} from '../providers/sambanova-docs.ts'
import { recordDocsFailing, readDocsFailing } from './docs-failing.ts'
import { pollProviderModels } from './poll-models.ts'

const MODELS_PAGE = `
## Production models

| **Developer** | **Model ID** | **Context length** | **Supported modalities** | **View on Hugging Face** |
| :- | :- | :- | :- | :- |
| **OpenAI** | \`gpt-oss-120b\` | 128k tokens | Text | [Model card](https://huggingface.co/openai/gpt-oss-120b) |
`

const TOOLS_PAGE = `
## Supported models

* \`gpt-oss-120b\`

## Example usage
`

const CHAT_SPEC = {
  components: {
    schemas: {
      ChatCompletionRequest: {
        properties: { temperature: { description: 'Sampling temperature.' } },
      },
    },
  },
}

it('clears the previous SambaNova docs outage after a healthy poll', async () => {
  const db = getDb(env)
  await recordDocsFailing(
    db,
    provider.id,
    {
      failed: 2,
      skipped: 0,
      first: [
        {
          source: SAMBANOVA_TOOLS_DOCS_URL,
          error: `fetch failed: ${SAMBANOVA_TOOLS_DOCS_URL} → 403 Forbidden`,
          elapsedMs: 1,
        },
      ],
    },
    1791521988,
  )
  expect(await readDocsFailing(db, provider.id)).toMatchObject({ polls: 1 })
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = requestUrl(input)
    if (url === provider.modelsEndpoint) {
      return Response.json({ data: [{ id: 'gpt-oss-120b' }] })
    }
    if (url === SAMBANOVA_MODELS_DOCS_URL) return new Response(MODELS_PAGE)
    if (url === SAMBANOVA_TOOLS_DOCS_URL) return new Response(TOOLS_PAGE)
    if (url === SAMBANOVA_SPEC_URL) return Response.json(CHAT_SPEC)
    throw new Error(`Unexpected SambaNova request: ${url}`)
  })
  try {
    const outcome = await pollProviderModels(
      {
        db,
        kv: env.SCHEMA_CACHE,
        secrets: { SAMBANOVA_API_KEY: 'test' },
        now: () => 1791799322,
      },
      provider,
    )
    expect(outcome.modelsSeen).toBe(1)
    expect(outcome.failures).toBe(0)
    expect(outcome.docsFailing).toBeUndefined()
    expect(await readDocsFailing(db, provider.id)).toBeNull()
  } finally {
    vi.unstubAllGlobals()
  }
})
