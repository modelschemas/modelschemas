import { afterEach, describe, expect, it } from 'vitest'

import {
  parseZaiContextWindows,
  parseZaiOutputCaps,
  parseZaiReasoning,
  provider,
  ZAI_OPENAPI_URL,
  ZAI_OVERVIEW_URL,
  ZAI_PRICING_URL,
  ZAI_THINKING_URL,
  zaiSpecFacts,
  zaiSupportedBy,
} from './zai.ts'

/** `max_tokens` descriptions of https://docs.z.ai/openapi.json (2026-10-06). */
const TEXT_MAX_TOKENS =
  'The maximum number of tokens for model output, the GLM-5.3, GLM-5.2, GLM-5.1, GLM-5, GLM-4.7, GLM-4.6 series supports 128K maximum output, the GLM-4.5 series supports 96K maximum output, the GLM-4.6v series supports 32K maximum output, the GLM-4.5v series supports 16K maximum output, GLM-4-32B-0414-128K supports 16K maximum output.'
const VISION_MAX_TOKENS =
  'The maximum number of tokens for model output. `GLM-5.3-Flash` series supports a maximum output length of 128K, the GLM-4.6V series supports 32K, the GLM-4.5V series supports 16K, and autoglm-phone-multilingual supports 4K. It is recommended to set it to no less than 1024.'

const part = (type: string) => ({
  type: 'object',
  properties: { type: { type: 'string', enum: [type] } },
})

const message = (role: string, content: Array<unknown>) => ({
  type: 'object',
  properties: {
    role: { type: 'string', enum: [role] },
    content: { oneOf: content },
  },
})

/** Excerpt of https://docs.z.ai/openapi.json (2026-10-06), same nesting. */
function spec(
  overrides: {
    textMaxTokens?: string
    visionMaxTokens?: string
    parts?: Array<string>
    thinking?: string
    visionTools?: string
  } = {},
) {
  const shared = {
    temperature: { type: 'number' },
    thinking: { $ref: '#/components/schemas/ChatThinking' },
    tool_choice: { oneOf: [{ type: 'string', enum: ['auto'] }] },
  }
  return {
    openapi: '3.0.1',
    info: { title: 'Z.AI API', version: '1' },
    paths: {
      '/paas/v4/chat/completions': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/ChatCompletionTextRequest' },
                    {
                      $ref: '#/components/schemas/ChatCompletionVisionRequest',
                    },
                  ],
                },
              },
            },
          },
          responses: { '200': {} },
        },
      },
      '/paas/v4/images/generations': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateImageRequest' },
              },
            },
          },
        },
      },
      '/paas/v4/tokenizer': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TokenizerRequest' },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        ChatCompletionTextRequest: {
          type: 'object',
          properties: {
            model: {
              type: 'string',
              enum: [
                'glm-5.3',
                'glm-5.2',
                'glm-5',
                'glm-4.7-flash',
                'glm-4.5-air',
                'glm-4-32b-0414-128k',
              ],
            },
            messages: {
              type: 'array',
              items: {
                oneOf: [
                  message('user', [{ type: 'string' }]),
                  message('system', [{ type: 'string' }]),
                ],
              },
            },
            max_tokens: {
              type: 'integer',
              description: overrides.textMaxTokens ?? TEXT_MAX_TOKENS,
              maximum: 131072,
            },
            reasoning_effort: {
              type: 'string',
              description:
                "Controls the model's reasoning effort level, takes effect when `thinking` is enabled. Default is `max`, supported by `GLM-5.2` and above. For the `GLM-5.3` `GLM-5.3-FLASH` model, only the `low` / `high` / `max` levels are supported.",
              enum: [
                'max',
                'xhigh',
                'high',
                'medium',
                'low',
                'minimal',
                'none',
              ],
            },
            response_format: {
              type: 'object',
              description:
                'Specifies the response format of the model. Defaults to text. Only text models support this field.',
              properties: { type: { type: 'string' } },
            },
            tool_stream: { type: 'boolean' },
            tools: {
              type: 'array',
              description:
                'A list of tools the model may call. Currently, only functions are supported as a tool. A max of 128 functions are supported.\n',
            },
            ...shared,
          },
        },
        ChatThinking: {
          type: 'object',
          description:
            overrides.thinking ??
            'Only supported by GLM-4.5 series and higher models. This parameter is used to control whether the model enable the chain of thought.',
          properties: { type: { type: 'string' } },
        },
        ChatCompletionVisionRequest: {
          type: 'object',
          properties: {
            model: {
              type: 'string',
              enum: [
                'glm-5.3-flashx',
                'glm-5.3-flash',
                'glm-4.6v',
                'glm-4.5v',
                'autoglm-phone-multilingual',
              ],
            },
            messages: {
              type: 'array',
              items: {
                oneOf: [
                  message('user', [
                    {
                      type: 'array',
                      items: {
                        $ref: '#/components/schemas/VisionMultimodalContentItem',
                      },
                    },
                    { type: 'string' },
                  ]),
                  message('assistant', [{ type: 'string' }]),
                ],
              },
            },
            max_tokens: {
              type: 'integer',
              description: overrides.visionMaxTokens ?? VISION_MAX_TOKENS,
              maximum: 131072,
            },
            reasoning_effort: {
              type: 'string',
              description:
                "Controls the model's reasoning effort level, takes effect when `thinking` is enabled. Default is `max`.",
              enum: ['max', 'high', 'low'],
            },
            tools: {
              type: 'array',
              description:
                overrides.visionTools ??
                'A list of tools the model may call. Only supported by `GLM-5.3-Flash` series, the GLM-4.6V series, and autoglm-phone-multilingual. Use this to provide a list of functions the model may generate JSON inputs for. A max of 128 functions are supported.\n',
            },
            ...shared,
          },
        },
        VisionMultimodalContentItem: {
          oneOf: (
            overrides.parts ?? ['text', 'image_url', 'video_url', 'file']
          ).map(part),
        },
        CreateImageRequest: {
          type: 'object',
          properties: { model: { type: 'string', enum: ['glm-image'] } },
        },
        TokenizerRequest: {
          type: 'object',
          properties: {
            model: { type: 'string', enum: ['glm-5', 'glm-ocr'] },
          },
        },
      },
    },
  }
}

/** Excerpt of https://docs.z.ai/guides/overview/pricing.md (2026-10-06). */
const PRICING = `
Prices per 1M tokens.

| Model | Input | Cached Input | Cached Input Storage | Output |
| :- | :- | :- | :- | :- |
| GLM-5.3 | \\$1.4 | \\$0.26 | Limited-time Free | \\$4.4 |
| GLM-5.3-Flash | \\$0.15 | \\$0.03 | Limited-time Free | \\$0.50 |
| GLM-4-32B-0414-128K | \\$0.1 | - | - | \\$0.1 |
| GLM-4.7-Flash | Free | Free | Free | Free |
| Not-A-Model | \\$9 | \\$1 | - | \\$9 |

### Image Generation Models

Prices per image.

| Model | Price |
| GLM-Image | \\$0.015 |
`

/** Excerpt of https://docs.z.ai/guides/overview/overview.md (2026-10-06). */
const OVERVIEW = `
## Featured Models

| Model | Strength | Language | Context | Resource |
| :- | :- | :- | :- | :- |
| GLM-5.3-Flash | Delivering frontier intelligence at radically lower cost | English & Chinese | 1M | [Guide](/guides/vlm/glm-5.3-flash) |
| GLM-5.3-FlashX | Delivering inference speeds of 200 tokens/s | English & Chinese | 1M | [Guide](/guides/vlm/glm-5.3-flash) |
| GLM-5.3 | Stronger in long-horizon, complex tasks | English & Chinese | 1M | [Guide](/guides/llm/glm-5.3) |
| GLM-5.2 | Open-source SOTA coding | English & Chinese | 1M | [Guide](/guides/llm/glm-5.2) |
| GLM-OCR | Document Parsing<br />Information Extraction | Multiple | / | [Guide](/guides/vlm/glm-ocr) |

<AccordionGroup>
  <Accordion title="Other Models, Agents and Tools">
    ### Text Models

    | Model | Strength | Language | Context | Resource |
    | :- | :- | :- | :- | :- |
    | GLM-5 | Agentic Long-Term Planning and Execution | English & Chinese | 200K | [Guide](/guides/llm/glm-5) |
    | GLM-4.5-Air | Cost-Effective<br />High Performance | English & Chinese | 128K | [Guide](/guides/llm/glm-4.5) |
    | GLM-4-32B-0414-128K | High intelligence | English & Chinese | 128K | [Guide](/guides/llm/glm-4-32b-0414-128k) |
    | GLM-4.7-Flash | Free, Lightweight | English & Chinese | 200K | [Guide](/guides/llm/glm-4.7) |

    ### Vision Models

    | Model | Strength | Language | Context | Resource |
    | :- | :- | :- | :- | :- |
    | GLM-4.6V | Native Function Call Support | English & Chinese | 128K | [Guide](/guides/vlm/glm-4.6v) |

    ### Built-in Tools

    | Tool | Capability |
    | :- | :- |
    | Web Search | Provide real-time, concise, direct answers |

    ### Image Generation Models

    | Model | Strength | Language | Resolution | Resource |
    | :- | :- | :- | :- | :- |
    | GLM-Image | Open-source SOTA in text rendering | English & Chinese | multiple resolutions | [Guide](/guides/image/glm-image) |
  </Accordion>
</AccordionGroup>
`

/** Excerpt of https://docs.z.ai/guides/capabilities/thinking.md (2026-10-06). */
const THINKING = `
### Core Parameters

* **\`reasoning_effort\`**: Controls the degree of reasoning within the thought chain, and is only supported by \`GLM-5.2\` and above.
  * Available values: \`max\` (default and recommended, deep inference), \`high\` (enhanced inference), \`low\` (mild inference, only supported by GLM-5.3 and GLM-5.3-FLASH)
  * In the API request:
  * * For GLM-5.3 and GLM-5.3-FLASH, only \`max\`, \`high\` and \`low\` are supported. Any other input will result in an error.
  * * For GLM-5.2, the supported options are \`max\` (default and recommended, for deep inference), \`xhigh\`, \`high\` (enhanced inference), \`medium\`, \`low\`, \`minimal\`, and \`none\`. Among them, \`none\` or \`minimal\` indicate that the model stops thinking; \`low\`/\`medium\` are mapped to \`high\`; \`xhigh\` is mapped to \`max\`.
  * In the Coding Plan request:
  * * For GLM-5.3 and GLM-5.3-FLASH, \`none\`, \`minimal\`, and \`low\` are mapped to \`low\`; \`medium\`, \`high\` are mapped to \`high\`; \`xhigh\` and \`max\` are mapped to \`max\`.
* **\`model\`**: A model that enables deep thinking, supported by \`GLM-4.5\` and above versions.
`

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function serve(docs: Record<string, string>): Array<string> {
  const urls: Array<string> = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    const body = docs[String(url)]
    return body === undefined
      ? Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
      : Promise.resolve(new Response(body))
  }) as typeof fetch
  return urls
}

const DOCS = {
  [ZAI_OPENAPI_URL]: JSON.stringify(spec()),
  [ZAI_PRICING_URL]: PRICING,
  [ZAI_OVERVIEW_URL]: OVERVIEW,
  [ZAI_THINKING_URL]: THINKING,
}

describe('zai', () => {
  it('lists OpenAPI model ids and per-1M prices that match those ids', async () => {
    const urls = serve(DOCS)

    const listed = await provider.listModels({})
    const fetched = await provider.fetchSpec({})
    const byId = new Map(listed.models.map((model) => [model.rawId, model]))

    expect(listed.models.map((model) => model.rawId)).toEqual([
      'glm-4-32b-0414-128k',
      'glm-4.5-air',
      'glm-4.5v',
      'glm-4.6v',
      'glm-4.7-flash',
      'glm-5',
      'glm-5.2',
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.3-flashx',
      'glm-image',
      'glm-ocr',
    ])
    expect(byId.get('glm-5.3')?.pricing).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 1.4 / 1_000_000,
            output_tokens: 4.4 / 1_000_000,
            cache_read_tokens: 0.26 / 1_000_000,
          },
        },
      },
    })
    expect(byId.get('glm-5.3-flash')?.pricing).toMatchObject({
      tables: {
        rate: {
          base: {
            input_tokens: 0.15 / 1_000_000,
            output_tokens: 0.5 / 1_000_000,
          },
        },
      },
    })
    // "Free" and "-" are not rates.
    expect(byId.get('glm-4.7-flash')?.pricing).toBeNull()
    expect(byId.get('glm-4-32b-0414-128k')?.pricing).not.toHaveProperty(
      'tables.rate.base.cache_read_tokens',
    )
    expect(byId.get('glm-image')?.pricing).toBeNull()
    expect(listed.models.some((model) => model.rawId === 'not-a-model')).toBe(
      false,
    )
    expect(fetched.specs).toHaveLength(1)
    expect(fetched.sources[0]?.url).toBe(ZAI_OPENAPI_URL)
    expect(provider.classify('/paas/v4/chat/completions', {})).toBe('chat')
    expect(provider.classify('/paas/v4/images/generations', {})).toBe('image')
    expect(provider.classify('/paas/v4/tokenizer', {})).toBeNull()
    expect(urls).toEqual([
      ZAI_OPENAPI_URL,
      ZAI_PRICING_URL,
      ZAI_OVERVIEW_URL,
      ZAI_THINKING_URL,
      ZAI_OPENAPI_URL,
    ])
    expect(provider.classify('/paas/v4/videos/generations', {})).toBe('video')
    expect(provider.classify('/paas/v4/audio/speech', {})).toBe('audio')
  })

  it('binds each id to the route whose request lists it', async () => {
    serve(DOCS)
    const { models } = await provider.listModels({})
    const byId = new Map(models.map((model) => [model.rawId, model]))

    for (const id of ['glm-5.3', 'glm-4.5-air', 'glm-4.6v', 'glm-5.3-flashx']) {
      expect(byId.get(id)?.activity).toBe('chat')
      expect(byId.get(id)?.schemaEndpointId).toBe('paas/v4/chat/completions')
    }
    // glm-5 is also a tokenizer model; the chat route binds it.
    expect(byId.get('glm-5')?.activity).toBe('chat')
    expect(byId.get('glm-image')?.activity).toBe('image')
    expect(byId.get('glm-image')?.schemaEndpointId).toBe(
      'paas/v4/images/generations',
    )
    // The tokenizer is not a generation route.
    expect(byId.get('glm-ocr')?.activity).toBeUndefined()
    expect(byId.get('glm-ocr')?.schemaEndpointId).toBeUndefined()
  })

  it('fills chat facts from the spec, the overview, and the thinking page', async () => {
    serve(DOCS)
    const { models } = await provider.listModels({})
    const byId = new Map(models.map((model) => [model.rawId, model]))

    expect(byId.get('glm-5.3')).toMatchObject({
      contextWindow: 1_000_000,
      // "128K" is the label of the spec's exact `maximum`.
      maxOutput: 131_072,
      modalities: { input: ['text'], output: ['text'] },
      reasoning: {
        mode: 'effort',
        mandatory: true,
        efforts: ['max', 'high', 'low'],
      },
    })
    expect(byId.get('glm-5.2')?.reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'],
    })
    // The vision request has its own cap list and content parts.
    expect(byId.get('glm-5.3-flashx')).toMatchObject({
      contextWindow: 1_000_000,
      maxOutput: 131_072,
      modalities: { input: ['text', 'image', 'video', 'file'] },
      reasoning: { mandatory: true, efforts: ['max', 'high', 'low'] },
    })
    expect(byId.get('glm-4.6v')).toMatchObject({
      contextWindow: 128_000,
      maxOutput: 32_000,
      modalities: { input: ['text', 'image', 'video', 'file'] },
    })
    // A series cap covers its variants; glm-5 is not glm-5.x.
    expect(byId.get('glm-4.5-air')?.maxOutput).toBe(96_000)
    expect(byId.get('glm-4.7-flash')?.maxOutput).toBe(131_072)
    expect(byId.get('glm-4-32b-0414-128k')?.maxOutput).toBe(16_000)
    expect(byId.get('glm-5')).toMatchObject({
      contextWindow: 200_000,
      maxOutput: 131_072,
    })
    // No effort list names these, so no reasoning object is invented.
    expect(byId.get('glm-5')?.reasoning).toBeUndefined()
    expect(byId.get('glm-4.6v')?.reasoning).toBeUndefined()
    // "/" and a Resolution column are not context windows.
    expect(byId.get('glm-ocr')?.contextWindow).toBeUndefined()
    expect(byId.get('glm-image')?.contextWindow).toBeUndefined()
  })

  it('names the document each fact came from', async () => {
    serve(DOCS)
    const { models } = await provider.listModels({})
    const sources = models.find(
      (model) => model.rawId === 'glm-5.3',
    )?.factSources

    expect(sources?.pricing).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: ZAI_PRICING_URL,
    })
    expect(sources?.contextWindow).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: ZAI_OVERVIEW_URL,
    })
    expect(sources?.reasoning).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: ZAI_THINKING_URL,
    })
    expect(sources?.maxOutput).toMatchObject({
      derivation: 'upstream-spec',
      sourceUrl: ZAI_OPENAPI_URL,
      path: 'max_tokens',
    })
    expect(sources?.modalities).toMatchObject({
      derivation: 'upstream-spec',
      sourceUrl: ZAI_OPENAPI_URL,
    })
    expect(sources?.maxOutput?.sourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(sources?.capabilities?.tools).toMatchObject({
      derivation: 'upstream-spec',
      sourceUrl: ZAI_OPENAPI_URL,
      endpointId: 'paas/v4/chat/completions',
      path: '/properties/tools',
    })
    // The thinking page does not name FlashX; its request variant's own
    // `reasoning_effort` enum is the same list.
    expect(
      models.find((model) => model.rawId === 'glm-5.3-flashx')?.factSources
        ?.reasoning,
    ).toMatchObject({
      derivation: 'upstream-spec',
      sourceUrl: ZAI_OPENAPI_URL,
      path: 'reasoning_effort',
    })
    expect(
      models.find((model) => model.rawId === 'glm-ocr')?.factSources,
    ).toBeUndefined()
  })

  it('lists only the flags the spec gives each model', async () => {
    serve(DOCS)
    const { models } = await provider.listModels({})
    const flags = (id: string) => {
      const model = models.find((row) => row.rawId === id)
      expect(model?.exactCapabilities).toBe(true)
      return [...(model?.capabilities as Array<string>)].sort()
    }
    const base = ['max_tokens', 'temperature']

    expect(flags('glm-5.3')).toEqual(
      [
        ...base,
        'reasoning',
        'reasoning_effort',
        'response_format',
        'tool_choice',
        'tools',
      ].sort(),
    )
    // `reasoning_effort` is "supported by GLM-5.2 and above".
    expect(flags('glm-5')).toEqual(
      [...base, 'reasoning', 'response_format', 'tool_choice', 'tools'].sort(),
    )
    // `thinking` is "GLM-4.5 series and higher".
    expect(flags('glm-4-32b-0414-128k')).toEqual(
      [...base, 'response_format', 'tool_choice', 'tools'].sort(),
    )
    // The vision request has no `response_format`.
    expect(flags('glm-5.3-flashx')).toEqual(
      [...base, 'reasoning', 'reasoning_effort', 'tool_choice', 'tools'].sort(),
    )
    // No effort list names glm-4.6v, whatever enum its variant carries.
    expect(flags('glm-4.6v')).toEqual(
      [...base, 'reasoning', 'tool_choice', 'tools'].sort(),
    )
    // Vision `tools` names the series it is supported by; not glm-4.5v.
    expect(flags('glm-4.5v')).toEqual([...base, 'reasoning'].sort())
    expect(
      models.find((row) => row.rawId === 'glm-image')?.capabilities,
    ).toBeUndefined()
  })

  it('throws on a 200 that is a web page', async () => {
    serve({
      ...DOCS,
      [ZAI_OVERVIEW_URL]: '<!DOCTYPE html><html><body>Not found</body></html>',
    })
    await expect(provider.listModels({})).rejects.toThrow(/returned HTML/)
  })
})

describe('zai parsers fail closed', () => {
  it('reads each output cap with its own models', () => {
    expect(parseZaiOutputCaps(VISION_MAX_TOKENS)).toEqual([
      { names: ['glm-5.3-flash'], series: true, tokens: 128_000 },
      { names: ['glm-4.6v'], series: true, tokens: 32_000 },
      { names: ['glm-4.5v'], series: true, tokens: 16_000 },
      { names: ['autoglm-phone-multilingual'], series: false, tokens: 4_000 },
    ])
  })

  it('throws on a reworded output cap', () => {
    // Without the throw, glm-4.5 would take the next clause's 32K.
    expect(() =>
      parseZaiOutputCaps(
        TEXT_MAX_TOKENS.replace(
          'supports 96K maximum output',
          'supports up to 96K of output',
        ),
      ),
    ).toThrow(/unreadable output cap/)
    // A clause with another verb must not take the next clause's cap:
    // unguarded, the 128K series would be stored as 96K ...
    expect(() =>
      parseZaiOutputCaps(
        TEXT_MAX_TOKENS.replace(
          'GLM-4.6 series supports 128K maximum output',
          'GLM-4.6 series allows up to 128K of output',
        ),
      ),
    ).toThrow(/unreadable output cap/)
    // ... and glm-4.6v as 16K.
    expect(() =>
      zaiSpecFacts(
        spec({
          visionMaxTokens: VISION_MAX_TOKENS.replace(
            'the GLM-4.6V series supports 32K',
            'the GLM-4.6V series can output 32K',
          ),
        }),
      ),
    ).toThrow(/unreadable output cap/)
    // The last clause has no next one to fall into; it is left over.
    expect(() =>
      parseZaiOutputCaps(
        VISION_MAX_TOKENS.replace(
          'autoglm-phone-multilingual supports 4K',
          'autoglm-phone-multilingual is capped at 4K',
        ),
      ),
    ).toThrow(/model with no output cap/)
    expect(() =>
      parseZaiOutputCaps('The maximum number of tokens for model output.'),
    ).toThrow(/states no output cap/)
    expect(() =>
      zaiSpecFacts(spec({ textMaxTokens: 'Up to 128K for every model.' })),
    ).toThrow(/states no output cap/)
  })

  it('drops a flag whose "supported by" clause it cannot read', () => {
    expect(zaiSupportedBy('A list of tools. A max of 128.', 'glm-5')).toBeNull()
    expect(
      zaiSupportedBy('Only supported by GLM-4.5 series and higher.', 'glm-5'),
    ).toBe(true)
    expect(
      zaiSupportedBy('Only supported by GLM-4.5 series and higher.', 'glm-4'),
    ).toBe(false)

    const reasoning = (thinking: string, id: string) =>
      Object.keys(
        zaiSpecFacts(spec({ thinking })).get(id)?.capabilities ?? {},
      ).includes('reasoning')
    // Reworded floor: nobody keeps the flag.
    expect(
      reasoning('Only supported by models newer than GLM-4.5.', 'glm-5.3'),
    ).toBe(false)
    expect(
      reasoning('Only supported by GLM-4.5 or GLM-5 on request.', 'glm-5'),
    ).toBe(false)

    const tools = Object.keys(
      zaiSpecFacts(
        spec({ visionTools: 'Only supported by most GLM-4.6V models.' }),
      ).get('glm-4.6v')?.capabilities ?? {},
    )
    expect(tools).not.toContain('tools')
    expect(tools).not.toContain('tool_choice')
  })

  it('throws on a content part it does not know', () => {
    expect(() =>
      zaiSpecFacts(spec({ parts: ['text', 'image_url', 'hologram_url'] })),
    ).toThrow(/unknown message content part: hologram_url/)
  })

  it('throws when the chat request lists no model ids', () => {
    const document = spec()
    document.components.schemas.ChatCompletionTextRequest.properties.model.enum =
      []
    document.components.schemas.ChatCompletionVisionRequest.properties.model.enum =
      []
    expect(() => zaiSpecFacts(document)).toThrow(/lists no model ids/)
  })

  it('throws on a context cell that is not a token count', () => {
    expect(() =>
      parseZaiContextWindows(OVERVIEW.replace('| 200K |', '| up to 200K |')),
    ).toThrow(/unreadable context window for GLM-5/)
    expect(() =>
      parseZaiContextWindows(OVERVIEW.replaceAll('Context', 'Window')),
    ).toThrow(/no context windows/)
  })

  it('throws on a reworded reasoning_effort list', () => {
    expect(() =>
      parseZaiReasoning(
        THINKING.replace(
          'For GLM-5.2, the supported options are',
          'GLM-5.2 takes',
        ),
      ),
    ).toThrow(/unreadable reasoning_effort line/)
    expect(() =>
      parseZaiReasoning(THINKING.replace('In the API request:', 'API:')),
    ).toThrow(/no API reasoning_effort list/)
  })
})
