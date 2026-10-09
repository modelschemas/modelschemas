import { afterEach, describe, expect, it } from 'vitest'

import { sha256Text } from '../types.ts'
import { NVIDIA_REFERENCE_INDEXES } from '../nvidia-openapi.ts'
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

const EMPTY_INDEX = '---\nupdatedAt: test\n---\n\n# Index\n'

function stubFetch(pages: Record<string, string>): Array<string> {
  const urls: Array<string> = []
  globalThis.fetch = ((input: string) => {
    const url = String(input)
    urls.push(url)
    const body =
      pages[url] ??
      (/\/nim\/reference\/[a-z0-9-]+-apis\.md$/.test(url)
        ? EMPTY_INDEX
        : undefined)
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
      exactCapabilities: true,
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

  it('reads older labeled input and output lines', () => {
    const card = `# Yi

## Input

-   Input Type: Text
-   Context length: 32k

## Output

-   Output Type: Text and Code

${CHAT_PROTOTYPE('01-ai/yi-large')}`
    expect(parseNvidiaCard(card)).toEqual({
      activity: 'chat',
      contextWindow: 32000,
      modalities: { input: ['text'], output: ['text'] },
    })
  })

  it('reads a labeled max output and prefers the Specifications context', () => {
    const card = `# Jamba

## Input:
**Max Input Tokens:** 256,000 <br>

## Output:
**Output Type:** Text <br>
**Max Output Tokens:** 256,000 <br>

## Specifications

- **Context Length:** 262,144 tokens
- **Input:** Text
- **Output:** Text
`
    expect(parseNvidiaCard(card)).toMatchObject({
      contextWindow: 262144,
      maxOutput: 256000,
      modalities: { input: ['text'], output: ['text'] },
    })
  })

  it('does not take an output modality from a mislabeled section', () => {
    const card = `# gemma

## Input:
**Input Type(s):** Text <br>

## Output:
**Input Type(s):** Text <br>

${CHAT_PROTOTYPE('google/gemma-2b')}`
    expect(parseNvidiaCard(card).modalities).toBeUndefined()
    expect(parseNvidiaCard(card).activity).toBe('chat')
  })

  it('reads bold Input and Output blocks and a pure format cell', () => {
    const bold = `# SEA-LION

**Input**
* Input Type: Text
* Input Format: String

**Output**
* Output Type: Text
* Output Format: String
`
    expect(parseNvidiaCard(bold).modalities).toEqual({
      input: ['text'],
      output: ['text'],
    })
    const format = `# StarCoder

## Input:
**Input Format:** Text <br>

## Output:
**Output Format:** Text (code) <br>
`
    expect(parseNvidiaCard(format).modalities).toEqual({
      input: ['text'],
      output: ['text'],
    })
    const stringFormat = `# Granite

**Input**
* Input Format: String

**Output**
* Output Format: String
`
    expect(parseNvidiaCard(stringFormat).modalities).toBeUndefined()
  })

  it('reads a context length of up to N outside the Input section', () => {
    const card = `# Gemma

Gemma models support a context length of up to 8K while using RoPE.
`
    expect(parseNvidiaCard(card).contextWindow).toBe(8000)
  })

  it('classifies a completions route and a VLM messages route as chat', () => {
    expect(
      parseNvidiaCard(`## Prototype

invoke_url='https://integrate.api.nvidia.com/v1/completions'
`).activity,
    ).toBe('chat')
    expect(
      parseNvidiaCard(`## Prototype

invoke_url = "https://ai.api.nvidia.com/v1/vlm/adept/fuyu-8b"
payload = {"messages": [{"role": "user", "content": ""}]}
`).activity,
    ).toBe('chat')
  })

  it('classifies an embedding card that names floats and no prototype URL', () => {
    const card = `---
description: "1B embedding model for semantic search."
---

## Output(s):

**Output Type(s):** Floats <br>

## Specifications

- **Context Length:** 32,768 tokens
`
    expect(parseNvidiaCard(card)).toMatchObject({
      activity: 'embeddings',
      contextWindow: 32768,
    })
    expect(parseNvidiaCard(card).modalities).toBeUndefined()
  })

  it('reads an enable_thinking table as a toggle that can be off', () => {
    const card = `# Nemotron

| **Reasoning Mode** | Configurable on/off via chat template (\`enable_thinking=True/False\`) |
`
    expect(parseNvidiaCard(card).reasoning).toEqual({
      mode: 'toggle',
      mandatory: false,
    })
  })

  it('reads a reasoning_effort list and an always-on sentence', () => {
    expect(
      parseNvidiaCard(
        'Thinking budget is controlled by `reasoning_effort`, which accepts `low`,\n`high`, or `max` and defaults to `max`.',
      ).reasoning,
    ).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'high', 'max'],
    })
    expect(
      parseNvidiaCard(
        '**Other Output Properties:** configurable low, high, or max reasoning effort. Thinking is always enabled.',
      ).reasoning,
    ).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['low', 'high', 'max'],
    })
    expect(
      parseNvidiaCard(
        '- **Configurable reasoning effort:** Easily adjust the reasoning effort (low, medium, high) based on latency.',
      ).reasoning,
    ).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'medium', 'high'],
    })
  })

  it('does not invent a reasoning object from prose that names no request field', () => {
    const card = `supported reasoning-strength settings are low, medium, high, and xhigh.
Use the prompt token <|think|>.
numeric reasoning effort from 1 to 100.

## Capabilities

- **Reasoning:** Supported
`
    const facts = parseNvidiaCard(card)
    expect(facts.reasoning).toBeUndefined()
    expect(facts.capabilities).toEqual(['reasoning'])
    expect(facts.exactCapabilities).toBe(true)
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
    await expect(provider.fetchSpec({})).rejects.toThrow(
      'parsed 0 generation specs',
    )

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
        exactCapabilities: true,
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
    expect(urls).toContain('https://build.nvidia.com/z-ai/glm-5_3-flash.md')
  })

  it('throws when no card names a route', async () => {
    stubFetch({ [NVIDIA_MODELS_URL]: JSON.stringify(LISTING) })
    await expect(provider.listModels({})).rejects.toThrow(
      'nvidia model cards: parsed 0 model rows',
    )
  })

  it('lists the ids and reports the cards when every card fails to load', async () => {
    globalThis.fetch = ((input: string) =>
      Promise.resolve(
        String(input) === NVIDIA_MODELS_URL
          ? new Response(JSON.stringify(LISTING))
          : new Response('busy', { status: 503 }),
      )) as typeof fetch
    const listed = await provider.listModels({})
    expect(listed.models).toHaveLength(LISTING.data.length)
    expect(listed.docsFailures).toMatchObject({
      failed: LISTING.data.length + NVIDIA_REFERENCE_INDEXES.length,
      skipped: 0,
    })
    expect(listed.docsFailures?.first[0]?.error).toContain('503')
    for (const model of listed.models) {
      expect(model.absent).toEqual({
        activity: 'unavailable',
        contextWindow: 'unavailable',
        maxOutput: 'unavailable',
        modalities: 'unavailable',
        capabilities: 'unavailable',
        reasoning: 'unavailable',
        requestMap: 'unavailable',
        schemaEndpointId: 'unavailable',
      })
    }
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

  it('keeps the other cards when one body is not a markdown card', async () => {
    stubFetch(cards('<!DOCTYPE html><html><body>Just a moment</body></html>'))
    const listed = await provider.listModels({})
    expect(listed.docsFailures?.first).toMatchObject([
      {
        source: 'https://build.nvidia.com/google/deplot.md',
        error:
          'nvidia: https://build.nvidia.com/google/deplot.md is not a markdown card',
      },
    ])
    const byId = new Map(listed.models.map((m) => [m.rawId, m]))
    expect(byId.get('01-ai/yi-large')).toMatchObject({ activity: 'chat' })
    expect(byId.get('01-ai/yi-large')?.absent).toBeUndefined()
    expect(byId.get('google/deplot')?.absent).toMatchObject({
      activity: 'unavailable',
    })
  })

  it('ignores a card whose canonical URL is another page', async () => {
    stubFetch(cards(YI_CARD))
    const listed = await provider.listModels({})
    expect(
      listed.models.find((m) => m.rawId === 'google/deplot')?.activity,
    ).toBeUndefined()
  })

  it('fills max output, reasoning, and the endpoint from that model OpenAPI', async () => {
    const infer =
      'https://docs.api.nvidia.com/nim/reference/z-ai-glm-5-3-flash-infer'
    const openapi = `# OpenAPI definition

\`\`\`json
{
  "openapi": "3.1.0",
  "paths": {
    "/chat/completions": {
      "post": {
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "max_tokens": {
                    "type": "integer",
                    "maximum": 8192,
                    "minimum": 1,
                    "description": "The maximum number of tokens to generate."
                  },
                  "model": { "type": "string", "default": "z-ai/glm-5.3-flash" },
                  "reasoning_effort": { "type": "string", "enum": ["none", "high"] }
                }
              }
            }
          }
        }
      }
    }
  }
}
\`\`\`
`
    stubFetch({
      [NVIDIA_MODELS_URL]: JSON.stringify(LISTING),
      'https://build.nvidia.com/z-ai/glm-5-3-flash.md': GLM_CARD,
      'https://build.nvidia.com/01-ai/yi-large.md': YI_CARD,
      [NVIDIA_REFERENCE_INDEXES[0]!]: `---
updatedAt: test
---

| Model | Endpoint |
| --- | --- |
| [z-ai / glm-5.3-flash](https://docs.api.nvidia.com/nim/reference/z-ai-glm-5-3-flash) | [chat](${infer}) |
`,
      [`${infer}.md`]: openapi,
    })
    const listed = await provider.listModels({})
    const glm = listed.models.find(
      (model) => model.rawId === 'z-ai/glm-5.3-flash',
    )
    expect(glm).toMatchObject({
      maxOutput: 8192,
      reasoning: {
        mode: 'effort',
        mandatory: false,
        efforts: ['none', 'high'],
      },
      schemaEndpointId: 'z-ai/glm-5.3-flash',
    })
    expect(glm?.factSources?.maxOutput).toMatchObject({
      sourceUrl: infer,
      path: 'max_tokens',
    })
    expect(glm?.factSources?.contextWindow?.sourceUrl).toBe(
      'https://build.nvidia.com/z-ai/glm-5-3-flash',
    )
    const spec = await provider.fetchSpec({})
    expect(spec.skipped).toBeUndefined()
    expect(spec.specs).toHaveLength(1)
    expect(spec.specs[0]?.paths).toHaveProperty('/z-ai/glm-5.3-flash')
    expect(
      provider.classify('/z-ai/glm-5.3-flash', {
        'x-modelschemas-activity': 'chat',
      }),
    ).toBe('chat')
  })

  it('does not copy an infer document that names a different model', async () => {
    const infer =
      'https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-content-safety-infer'
    const openapi = `# OpenAPI definition

\`\`\`json
{
  "openapi": "3.1.0",
  "info": { "title": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" },
  "paths": {
    "/chat/completions": {
      "post": {
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "model": {
                    "type": "string",
                    "default": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"
                  },
                  "max_tokens": {
                    "type": "integer",
                    "maximum": 65536,
                    "description": "The maximum number of tokens to generate."
                  },
                  "reasoning_budget": { "type": "integer", "maximum": 32768 }
                }
              }
            }
          }
        }
      }
    }
  }
}
\`\`\`
`
    stubFetch({
      [NVIDIA_MODELS_URL]: JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'nvidia/nemotron-3.5-content-safety',
            object: 'model',
            created: 735790403,
            owned_by: 'nvidia',
          },
        ],
      }),
      'https://build.nvidia.com/nvidia/nemotron-3.5-content-safety.md': `---
title: "nemotron-3.5-content-safety"
canonical: "https://build.nvidia.com/nvidia/nemotron-3.5-content-safety"
---

## Specifications

- **Context Length:** 131,072 tokens
- **Input:** Text
- **Output:** Text

## Capabilities

- **Reasoning:** Supported

${CHAT_PROTOTYPE('nvidia/nemotron-3.5-content-safety')}`,
      [NVIDIA_REFERENCE_INDEXES[0]!]: `---
updatedAt: test
---

| Model | Endpoint |
| --- | --- |
| [nvidia / nemotron-3.5-content-safety](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-content-safety) | [chat](${infer}) |
`,
      [`${infer}.md`]: openapi,
    })
    const listed = await provider.listModels({})
    const safety = listed.models.find(
      (model) => model.rawId === 'nvidia/nemotron-3.5-content-safety',
    )
    expect(safety?.maxOutput).toBeUndefined()
    expect(safety?.reasoning).toBeUndefined()
    expect(safety?.schemaEndpointId).toBeUndefined()
    expect(safety?.contextWindow).toBe(131072)
    await expect(provider.fetchSpec({})).rejects.toThrow(
      'parsed 0 generation specs',
    )
  })
})

it('reads hosted replay instructions rather than copying maker behavior', () => {
  const card =
    '# Native card\n\n## Prototype\nPOST /v1/chat/completions\n\nClients must pass back the complete assistant message, including reasoning_content and tool_calls.'
  expect(parseNvidiaCard(card).requestMap?.replayReasoningContent).toBe(true)
  expect(
    parseNvidiaCard(
      card.replace(
        'must pass back the complete assistant message, including',
        'returns',
      ),
    ).requestMap,
  ).toBeUndefined()
})
