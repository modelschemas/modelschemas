import { describe, expect, it } from 'vitest'

import { findDanglingRefs } from '#/server/ingest/bundle.ts'
import { classifyAndBundle } from '#/server/ingest/sync.ts'
import { byteplusProvider } from './byteplus.ts'

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

describe('byteplus curated models', () => {
  it('lists the ported @tanstack/ai-byteplus catalog with metadata', async () => {
    const { models, skipped } = await byteplusProvider.listModels({})
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
