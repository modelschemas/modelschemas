import { afterEach, describe, expect, it } from 'vitest'

import { sha256Text } from '../types.ts'
import { NVIDIA_MODELS_URL, parseNvidiaCard, provider } from './nvidia.ts'

/** Excerpt of https://integrate.api.nvidia.com/v1/models (2026-10-06). */
const LISTING = {
  object: 'list',
  data: [
    {
      id: '01-ai/yi-large',
      object: 'model',
      created: 735790403,
      owned_by: '01-ai',
    },
    {
      id: 'z-ai/glm-5.3-flash',
      object: 'model',
      created: 735790403,
      owned_by: 'z-ai',
    },
    {
      id: 'google/deplot',
      object: 'model',
      created: 735790403,
      owned_by: 'google',
    },
  ],
}

const CHAT_PROTOTYPE = (model: string) => `## Prototype

\`\`\`bash
curl --fail --show-error --no-buffer https://integrate.api.nvidia.com/v1/chat/completions \\
-H "Authorization: Bearer $NVIDIA_API_KEY" \\
--data-binary @- <<'JSON'
{
"model": "${model}",
"messages": [{"role":"user","content":""}]
}
JSON
\`\`\``

/** Excerpt of https://build.nvidia.com/z-ai/glm-5-3-flash.md (2026-10-06). */
const GLM_CARD = `---
title: "glm-5-3-flash"
publisher: "z-ai"
type: "endpoint"
canonical: "https://build.nvidia.com/z-ai/glm-5-3-flash"
---

# GLM-5.3-Flash

## Description
GLM-5.3-Flash is a multimodal mixture-of-experts model.

## Specifications

- **Context Length:** 1,048,576 tokens
- **Parameters:** 320B
- **Input:** Text, Image
- **Output:** Text

## Capabilities

- **Function Calling:** Supported
- **Structured Output:** Supported
- **Reasoning:** Supported

${CHAT_PROTOTYPE('z-ai/glm-5.3-flash')}`

/** Excerpt of https://build.nvidia.com/01-ai/yi-large.md: an older card. */
const YI_CARD = `---
title: "yi-large"
publisher: "01-ai"
canonical: "https://build.nvidia.com/01-ai/yi-large"
---

# Yi-Large

### Input
- **Input Type:** Text

${CHAT_PROTOTYPE('01-ai/yi-large')}`

/** Excerpt of https://build.nvidia.com/nvidia/embed-qa-4.md. */
const EMBED_CARD = `# NV-Embed-QA

## Prototype

\`\`\`bash
curl -X POST https://integrate.api.nvidia.com/v1/embeddings \\
-d '{"input": [""], "model": "nvidia/embed-qa-4"}'
\`\`\``

/**
 * Excerpt of https://build.nvidia.com/nvidia/nemotron-parse.md
 * (2026-10-06): HTTP 200, text/html, for a card with no markdown twin.
 */
const NOT_FOUND_HTML = `<!DOCTYPE html><html id="__next_error__"><head><meta charSet="utf-8"/></head><body><script>self.__next_f.push([1,"2c:E{\\"digest\\":\\"NEXT_HTTP_ERROR_FALLBACK;404\\"}\\n"])</script></body></html>`

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(pages: Record<string, string>): Array<string> {
  const urls: Array<string> = []
  globalThis.fetch = ((input: string) => {
    const url = String(input)
    urls.push(url)
    const body = pages[url]
    return Promise.resolve(
      body === undefined
        ? new Response('Not found', { status: 404 })
        : new Response(body),
    )
  }) as typeof fetch
  return urls
}

describe('parseNvidiaCard', () => {
  it('reads the Specifications and Capabilities lists', () => {
    expect(parseNvidiaCard(GLM_CARD)).toEqual({
      activity: 'chat',
      contextWindow: 1048576,
      modalities: { input: ['text', 'image'], output: ['text'] },
      capabilities: ['tools', 'structured_outputs', 'reasoning'],
    })
  })

  it('states only the activity for a card without those lists', () => {
    expect(parseNvidiaCard(YI_CARD)).toEqual({ activity: 'chat' })
  })

  it('reads an embeddings prototype and leaves other routes null', () => {
    expect(parseNvidiaCard(EMBED_CARD)).toEqual({ activity: 'embeddings' })
    expect(parseNvidiaCard('# Card\n\n## Prototype\n\nnone')).toEqual({
      activity: null,
    })
  })
})

describe('nvidia', () => {
  it('joins listed ids to their cards and leaves prices null', async () => {
    const urls = stubFetch({
      [NVIDIA_MODELS_URL]: JSON.stringify(LISTING),
      'https://build.nvidia.com/01-ai/yi-large.md': YI_CARD,
      'https://build.nvidia.com/z-ai/glm-5-3-flash.md': GLM_CARD,
    })

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    const source = {
      derivation: 'docs-derived',
      sourceUrl: 'https://build.nvidia.com/z-ai/glm-5-3-flash',
      sourceHash: await sha256Text(GLM_CARD),
    }
    expect(listed.models).toEqual([
      {
        rawId: '01-ai/yi-large',
        releasedAt: 735790403,
        pricing: null,
        activity: 'chat',
        factSources: {},
      },
      {
        rawId: 'z-ai/glm-5.3-flash',
        releasedAt: 735790403,
        pricing: null,
        activity: 'chat',
        contextWindow: 1048576,
        modalities: { input: ['text', 'image'], output: ['text'] },
        capabilities: ['tools', 'structured_outputs', 'reasoning'],
        factSources: {
          contextWindow: { ...source, path: 'contextWindow' },
          modalities: { ...source, path: 'modalities' },
          capabilities: {
            tools: { ...source, path: 'capabilities.tools' },
            structured_outputs: {
              ...source,
              path: 'capabilities.structured_outputs',
            },
            reasoning: { ...source, path: 'capabilities.reasoning' },
          },
        },
      },
      // No card under any slug: listed, no facts.
      { rawId: 'google/deplot', releasedAt: 735790403, pricing: null },
    ])
    expect(spec.skipped).toContain('skipped')
    expect(urls).toContain('https://build.nvidia.com/z-ai/glm-5_3-flash.md')
  })

  it('throws when no card names a route', async () => {
    stubFetch({ [NVIDIA_MODELS_URL]: JSON.stringify(LISTING) })
    await expect(provider.listModels({})).rejects.toThrow(
      'nvidia model cards: parsed 0 model rows',
    )
  })

  it('throws on a card that fails to load', async () => {
    globalThis.fetch = ((input: string) =>
      Promise.resolve(
        String(input) === NVIDIA_MODELS_URL
          ? new Response(JSON.stringify(LISTING))
          : new Response('busy', { status: 503 }),
      )) as typeof fetch
    await expect(provider.listModels({})).rejects.toThrow('503')
  })

  const cards = (deplot: string) => ({
    [NVIDIA_MODELS_URL]: JSON.stringify(LISTING),
    'https://build.nvidia.com/01-ai/yi-large.md': YI_CARD,
    'https://build.nvidia.com/google/deplot.md': deplot,
  })

  it('reads the HTML not-found page served with 200 as no card', async () => {
    stubFetch(cards(NOT_FOUND_HTML))
    const listed = await provider.listModels({})
    expect(listed.models.find((m) => m.rawId === 'google/deplot')).toEqual({
      rawId: 'google/deplot',
      releasedAt: 735790403,
      pricing: null,
    })
  })

  it('throws on any other body that is not a markdown card', async () => {
    stubFetch(cards('<!DOCTYPE html><html><body>Just a moment</body></html>'))
    await expect(provider.listModels({})).rejects.toThrow(
      'https://build.nvidia.com/google/deplot.md is not a markdown card',
    )
  })

  it('ignores a card whose canonical URL is another page', async () => {
    stubFetch(cards(YI_CARD))
    const listed = await provider.listModels({})
    expect(
      listed.models.find((m) => m.rawId === 'google/deplot')?.activity,
    ).toBeUndefined()
  })
})
