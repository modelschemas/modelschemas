import { describe, expect, it } from 'vitest'

import { findDanglingRefs } from '#/server/ingest/bundle.ts'
import { classifyAndBundle } from '#/server/ingest/sync.ts'
import { arkTaskActivity, byteplusProvider } from './byteplus.ts'

describe('byteplus embedded spec', () => {
  it('classifies and bundles the five endpoints without warnings', async () => {
    const fetched = await byteplusProvider.fetchSpec({})
    expect(fetched.specs).toHaveLength(2)
    expect(fetched.sources).toHaveLength(2)
    for (const source of fetched.sources) {
      expect(source.url).toMatch(/^https:\/\/docs\.byteplus\.com\//)
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

  it('derives identical content hashes on every build (sync idempotence)', async () => {
    const [a, b] = await Promise.all([
      byteplusProvider.fetchSpec({}),
      byteplusProvider.fetchSpec({}),
    ])
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
