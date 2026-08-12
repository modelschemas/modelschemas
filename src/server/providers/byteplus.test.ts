import { describe, expect, it } from 'vitest'

import { findDanglingRefs } from '#/server/ingest/bundle.ts'
import { classifyAndBundle } from '#/server/ingest/sync.ts'
import { arkTaskActivity, byteplusProvider } from './byteplus.ts'

/**
 * Minimal stand-ins for the four `service/arkruntime/model` files fetchSpec
 * pulls — enough Go to define every endpoint root and its closure.
 */
const GO_FIXTURES: Record<string, string> = {
  'chat_completion.go': `
type ThinkingType string
const (
	ThinkingTypeEnabled  ThinkingType = "enabled"
	ThinkingTypeDisabled ThinkingType = "disabled"
)
type Thinking struct {
	Type ThinkingType \`json:"type"\`
}
type ChatCompletionMessage struct {
	Role    string \`json:"role"\`
	Content string \`json:"content,omitempty"\`
}
type CreateChatCompletionRequest struct {
	Model       string                   \`json:"model"\`
	Messages    []*ChatCompletionMessage \`json:"messages"\`
	MaxTokens   *int                     \`json:"max_tokens,omitempty"\`
	Thinking    *Thinking                \`json:"thinking,omitempty"\`
	ServiceTier *string                  \`json:"service_tier,omitempty"\`
}
type ChatCompletionResponse struct {
	ID    string \`json:"id"\`
	Model string \`json:"model"\`
	Usage Usage  \`json:"usage"\`
}
`,
  'images.go': `
type GenerateImagesRequest struct {
	Model     string  \`json:"model"\`
	Prompt    string  \`json:"prompt"\`
	Size      *string \`json:"size,omitempty"\`
	Watermark *bool   \`json:"watermark,omitempty"\`
}
type ImagesResponse struct {
	Model string \`json:"model"\`
}
`,
  'content_generation.go': `
type CreateContentGenerationContentItem struct {
	Type string  \`json:"type"\`
	Text *string \`json:"text,omitempty"\`
}
type ExtraBody map[string]interface{}
type CreateContentGenerationTaskRequest struct {
	Model      string                                \`json:"model"\`
	Content    []*CreateContentGenerationContentItem \`json:"content"\`
	Resolution *string                               \`json:"resolution,omitempty"\`
	ExtraBody  \`json:"-"\`
}
type CreateContentGenerationTaskResponse struct {
	ID string \`json:"id"\`
}
`,
  'common.go': `
type Usage struct {
	PromptTokens int \`json:"prompt_tokens"\`
	TotalTokens  int \`json:"total_tokens"\`
}
`,
}

/** Serve the Go fixtures (or fail them) for the duration of `run`. */
async function withGoSdk<T>(
  mode: 'ok' | 'unreachable',
  run: () => Promise<T>,
): Promise<{ result: T; urls: Array<string> }> {
  const original = globalThis.fetch
  const urls: Array<string> = []
  globalThis.fetch = ((url: string) => {
    const href = String(url)
    urls.push(href)
    if (mode === 'unreachable') return Promise.reject(new Error('network down'))
    const file = Object.keys(GO_FIXTURES).find((f) => href.endsWith(f))
    return Promise.resolve(
      file
        ? new Response(GO_FIXTURES[file])
        : new Response('not found', { status: 404 }),
    )
  }) as typeof fetch
  try {
    return { result: await run(), urls }
  } finally {
    globalThis.fetch = original
  }
}

describe('byteplus spec generated from the Go SDK', () => {
  it('classifies and bundles the five endpoints without warnings', async () => {
    const { result: fetched, urls } = await withGoSdk('ok', () =>
      byteplusProvider.fetchSpec({}),
    )
    // All four model files come from the SDK's default branch.
    expect(urls).toHaveLength(4)
    for (const url of urls) {
      expect(url).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/byteplus-sdk\/byteplus-go-sdk-v2\/main\/service\/arkruntime\/model\/\w+\.go$/,
      )
    }
    expect(fetched.warnings ?? []).toEqual([])
    expect(fetched.specs).toHaveLength(2)
    // Ark is provenanced to the SDK; Seed Speech stays on the docs URL.
    expect(fetched.sources[0]?.url).toBe(
      'https://github.com/byteplus-sdk/byteplus-go-sdk-v2/tree/main/service/arkruntime/model',
    )
    expect(fetched.sources[1]?.url).toMatch(/^https:\/\/docs\.byteplus\.com\//)
    for (const source of fetched.sources) {
      expect(source.hash).toMatch(/^[0-9a-f]{64}$/)
    }

    const { endpoints, warnings } = classifyAndBundle(byteplusProvider, fetched)
    expect(warnings).toEqual([])
    expect(endpoints.map((e) => [e.dbId, e.activity]).sort()).toEqual([
      ['byteplus/auc/bigmodel/recognize/flash', 'audio'],
      ['byteplus/chat/completions', 'chat'],
      ['byteplus/contents/generations/tasks', 'video'],
      ['byteplus/images/generations', 'image'],
      ['byteplus/tts/create', 'audio'],
    ])

    for (const endpoint of endpoints) {
      expect(endpoint.input, endpoint.dbId).toBeDefined()
      expect(endpoint.output, endpoint.dbId).toBeDefined()
      if (endpoint.input) expect(findDanglingRefs(endpoint.input)).toEqual([])
      if (endpoint.output) expect(findDanglingRefs(endpoint.output)).toEqual([])
    }

    const chat = endpoints.find((e) => e.dbId === 'byteplus/chat/completions')
    expect(chat?.input?.required).toEqual(['model', 'messages'])
    const video = endpoints.find(
      (e) => e.dbId === 'byteplus/contents/generations/tasks',
    )
    expect(video?.input?.required).toEqual(['model', 'content'])
  })

  it('re-applies curated fields and descriptions the SDK omits', async () => {
    const { result: fetched } = await withGoSdk('ok', () =>
      byteplusProvider.fetchSpec({}),
    )
    const { endpoints } = classifyAndBundle(byteplusProvider, fetched)
    const chat = endpoints.find((e) => e.dbId === 'byteplus/chat/completions')
    const props = chat?.input?.properties as Record<
      string,
      Record<string, unknown>
    >
    // Present in the fixture, so straight from the SDK.
    expect(props.thinking).toBeDefined()
    // Absent from the SDK entirely — restored from the curated list.
    expect(props.reasoning_effort).toMatchObject({ type: 'string' })
    expect(props.top_k).toMatchObject({ type: 'integer' })
    expect(props.seed).toMatchObject({ type: 'integer' })
    // Curated prose beats the (here absent) Go doc comment.
    expect(String(props.model?.description)).toContain('Ark model id')

    const image = endpoints.find(
      (e) => e.dbId === 'byteplus/images/generations',
    )
    const imageProps = image?.input?.properties as Record<
      string,
      Record<string, unknown>
    >
    expect(String(imageProps.watermark?.description)).toContain(
      'DEFAULTS TO TRUE',
    )
  })

  it('falls back to the embedded document when the SDK is unreachable', async () => {
    const { result: fetched } = await withGoSdk('unreachable', () =>
      byteplusProvider.fetchSpec({}),
    )
    expect(fetched.specs).toHaveLength(2)
    expect(fetched.sources[0]?.url).toMatch(/^https:\/\/docs\.byteplus\.com\//)
    expect(fetched.warnings?.[0]).toContain('served the embedded Ark document')

    // Degraded freshness, not a degraded service: all five endpoints survive.
    const { endpoints, warnings } = classifyAndBundle(byteplusProvider, fetched)
    expect(warnings).toEqual([])
    expect(endpoints).toHaveLength(5)
  })

  it('derives identical content hashes on every build (sync idempotence)', async () => {
    const { result: a } = await withGoSdk('ok', () =>
      byteplusProvider.fetchSpec({}),
    )
    const { result: b } = await withGoSdk('ok', () =>
      byteplusProvider.fetchSpec({}),
    )
    expect(a.sources.map((s) => s.hash)).toEqual(b.sources.map((s) => s.hash))
  })
})

describe('byteplus curated models (no ARK_API_KEY)', () => {
  it('lists the ported @tanstack/ai-byteplus catalog with metadata', async () => {
    const { models, skipped } = await byteplusProvider.listModels({})
    // Keyless is a supported mode, not a skip: the embedded catalog stands in.
    expect(skipped).toBeUndefined()
    // 18 chat + 7 video + 5 image + 2 speech.
    expect(models).toHaveLength(32)
    expect(new Set(models.map((m) => m.rawId)).size).toBe(32)

    const byActivity = new Map<string, number>()
    for (const m of models) {
      expect(m.activity, m.rawId).toBeTruthy()
      byActivity.set(
        m.activity ?? '',
        (byActivity.get(m.activity ?? '') ?? 0) + 1,
      )
    }
    expect(byActivity.get('chat')).toBe(18)
    expect(byActivity.get('video')).toBe(7)
    expect(byActivity.get('image')).toBe(5)
    expect(byActivity.get('audio')).toBe(2)

    const seedance = models.find((m) => m.rawId === 'seedance-1-5-pro-251215')
    expect(seedance?.releasedAt).toBe(Date.parse('2025-12-15') / 1000)
    // Undated Seed Speech ids keep their poll-time firstSeenAt.
    const asr = models.find((m) => m.rawId === 'seed-asr')
    expect(asr?.releasedAt).toBeNull()

    const glm = models.find((m) => m.rawId === 'glm-5-2-260617')
    expect(glm?.contextWindow).toBe(1_024_000)
    expect(glm?.maxOutput).toBe(128_000)
  })
})

describe('ark task_type → activity', () => {
  it('prefers generation task types over the modality-input ones', () => {
    // Chat models that accept audio input carry SpeechToText alongside
    // TextGeneration; they are chat endpoints, not transcription ones.
    expect(
      arkTaskActivity([
        'TextGeneration',
        'VisualQuestionAnswering',
        'SpeechToText',
      ]),
    ).toBe('chat')
    expect(arkTaskActivity(['ImageToVideo', 'TextToVideo'])).toBe('video')
    expect(arkTaskActivity(['MultimodalToVideo', 'VideoEditing'])).toBe('video')
    expect(arkTaskActivity(['ImageToImage', 'TextToImage'])).toBe('image')
    expect(
      arkTaskActivity([
        'ImageEmbedding',
        'MultimodalEmbedding',
        'TextEmbedding',
      ]),
    ).toBe('embeddings')
    expect(arkTaskActivity(['SpeechToText'])).toBe('audio')
    // 3D-generation models report no task_type at all.
    expect(arkTaskActivity([])).toBeNull()
    expect(arkTaskActivity(undefined)).toBeNull()
    expect(arkTaskActivity(['SomethingNew'])).toBeNull()
  })
})

describe('byteplus live models (ARK_API_KEY set)', () => {
  // Verbatim rows from Ark's GET /models, captured 2026-08-12.
  const ARK_PAGE = {
    data: [
      {
        id: 'seed-2-0-lite-260428',
        name: 'seed-2-0-lite',
        created: 1_778_162_292,
        domain: 'VLM',
        task_type: [
          'TextGeneration',
          'VisualQuestionAnswering',
          'SpeechToText',
        ],
        modalities: {
          input_modalities: ['text', 'image', 'video', 'audio'],
          output_modalities: ['text'],
        },
        token_limits: {
          context_window: 262_144,
          max_output_token_length: 131_072,
          max_reasoning_token_length: 131_072,
        },
        features: {
          structured_outputs: { json_object: true, json_schema: true },
          tools: { function_calling: true },
        },
      },
      {
        id: 'kimi-k2-250905',
        name: 'kimi-k2',
        created: 1_757_927_317,
        status: 'Shutdown',
        domain: 'LLM',
        task_type: ['TextGeneration'],
        modalities: { input_modalities: ['text'], output_modalities: ['text'] },
        token_limits: {
          context_window: 262_144,
          max_output_token_length: 32_768,
        },
        features: {},
      },
      {
        id: 'hitem3d-2-0-251223',
        name: 'hitem3d-2-0',
        created: 1_774_855_941,
        domain: '3DGeneration',
        modalities: {},
        token_limits: {},
        features: {},
      },
    ],
  }

  function withStubbedFetch<T>(body: unknown, run: () => Promise<T>) {
    const original = globalThis.fetch
    const calls: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get('authorization'),
      })
      return Promise.resolve(new Response(JSON.stringify(body)))
    }) as typeof fetch
    return run()
      .then((result) => ({ result, calls }))
      .finally(() => {
        globalThis.fetch = original
      })
  }

  it('maps live rows and sends the bearer key', async () => {
    const { result, calls } = await withStubbedFetch(ARK_PAGE, () =>
      byteplusProvider.listModels({ ARK_API_KEY: 'ark-test' }),
    )
    expect(calls[0]?.url).toBe(
      'https://ark.ap-southeast.bytepluses.com/api/v3/models',
    )
    expect(calls[0]?.auth).toBe('Bearer ark-test')

    const seed = result.models.find((m) => m.rawId === 'seed-2-0-lite-260428')
    expect(seed?.activity).toBe('chat')
    expect(seed?.displayName).toBe('seed-2-0-lite')
    expect(seed?.contextWindow).toBe(262_144)
    expect(seed?.maxOutput).toBe(131_072)
    // Upstream `created` beats the id-suffix fallback.
    expect(seed?.releasedAt).toBe(1_778_162_292)
    expect(seed?.modalities).toEqual({
      input: ['text', 'image', 'video', 'audio'],
      output: ['text'],
    })
    expect(seed?.deprecated).toBe(false)

    // Shutdown and Retiring both read as deprecated.
    expect(
      result.models.find((m) => m.rawId === 'kimi-k2-250905')?.deprecated,
    ).toBe(true)
    // 3D generation is outside our taxonomy.
    expect(
      result.models.find((m) => m.rawId === 'hitem3d-2-0-251223')?.activity,
    ).toBeNull()
  })

  it('keeps the probed structured-output verdict beside the wrong upstream flag', async () => {
    const { result } = await withStubbedFetch(ARK_PAGE, () =>
      byteplusProvider.listModels({ ARK_API_KEY: 'ark-test' }),
    )
    const caps = result.models.find((m) => m.rawId === 'seed-2-0-lite-260428')
      ?.capabilities as Record<string, unknown>
    // Ark advertises json_schema support for this model...
    expect(caps.structured_outputs).toEqual({
      json_object: true,
      json_schema: true,
    })
    // ...but a real request 400s, so the probe verdict rides alongside it.
    expect(caps.structuredOutputProbed).toBe(false)
    expect(caps.taskType).toEqual([
      'TextGeneration',
      'VisualQuestionAnswering',
      'SpeechToText',
    ])
  })

  it('fills the gaps the listing omits from the curated catalog', async () => {
    const { result } = await withStubbedFetch(ARK_PAGE, () =>
      byteplusProvider.listModels({ ARK_API_KEY: 'ark-test' }),
    )
    const ids = result.models.map((m) => m.rawId)
    expect(new Set(ids).size).toBe(ids.length)
    // Seed Speech lives on another host and is in no Ark listing.
    expect(ids).toContain('seed-audio-1.0')
    expect(ids).toContain('seed-asr')
    // Served by Ark but absent from its own listing.
    expect(ids).toContain('seedream-5-0-lite-260128')
    // A live row must not be duplicated by its curated twin.
    expect(ids.filter((id) => id === 'seed-2-0-lite-260428')).toHaveLength(1)
  })
})

describe('byteplus schema provenance', () => {
  it('grades each endpoint by how its schema was arrived at', async () => {
    const { result: fetched } = await withGoSdk('ok', () =>
      byteplusProvider.fetchSpec({}),
    )
    const { endpoints } = classifyAndBundle(byteplusProvider, fetched)
    const by = new Map(
      endpoints.map((e) => [e.dbId, [e.derivation, e.verifiedAt] as const]),
    )
    // Ark is re-derived from the Go SDK every sync, so it self-heals and
    // carries no point-in-time claim.
    expect(by.get('byteplus/chat/completions')).toEqual(['generated', null])
    expect(by.get('byteplus/images/generations')).toEqual(['generated', null])
    expect(by.get('byteplus/contents/generations/tasks')).toEqual([
      'generated',
      null,
    ])
    // Seed Speech is hand-written: TTS was exercised live, ASR never was.
    expect(by.get('byteplus/tts/create')).toEqual([
      'probe-verified',
      '2026-08-12',
    ])
    expect(by.get('byteplus/auc/bigmodel/recognize/flash')).toEqual([
      'docs-derived',
      null,
    ])
  })

  it('downgrades Ark to a dated claim when it falls back to the embedded doc', async () => {
    const { result: fetched } = await withGoSdk('unreachable', () =>
      byteplusProvider.fetchSpec({}),
    )
    const { endpoints } = classifyAndBundle(byteplusProvider, fetched)
    const chat = endpoints.find((e) => e.dbId === 'byteplus/chat/completions')
    // No longer self-healing, and it says so.
    expect(chat?.derivation).toBe('probe-verified')
    expect(chat?.verifiedAt).toBe('2026-07-31')
  })
})
