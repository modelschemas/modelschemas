import { describe, expect, it } from 'vitest'

import { provider } from './assemblyai.ts'

describe('assemblyai classify', () => {
  it('maps transcript and streaming generation paths to audio', () => {
    expect(provider.classify('/v2/transcript', {})).toBe('audio')
    expect(provider.classify('/v2/transcript#create', {})).toBe('audio')
    expect(provider.classify('/v2/realtime/ws', {})).toBe('audio')
    expect(provider.classify('/v3/ws', {})).toBe('audio')
  })

  it('drops upload, retrieval, and platform paths', () => {
    expect(provider.classify('/v2/upload', {})).toBeNull()
    expect(provider.classify('/v2/transcript/{transcript_id}', {})).toBeNull()
    expect(
      provider.classify('/v2/transcript/{transcript_id}/sentences', {}),
    ).toBeNull()
    expect(
      provider.classify('/v2/transcript/{transcript_id}/paragraphs', {}),
    ).toBeNull()
    expect(
      provider.classify('/v2/transcript/{transcript_id}/word-search', {}),
    ).toBeNull()
    expect(
      provider.classify('/v2/transcript/{transcript_id}/redacted-audio', {}),
    ).toBeNull()
    expect(provider.classify('/v2/realtime/token', {})).toBeNull()
    expect(provider.classify('/lemur/v3/generate/task', {})).toBeNull()
  })
})

describe('assemblyai listModels', () => {
  it('skips with an empty catalog when ASSEMBLYAI_API_KEY is absent', async () => {
    const { models, skipped } = await provider.listModels({})
    expect(models).toEqual([])
    expect(skipped).toBe('assemblyai: ASSEMBLYAI_API_KEY not set — skipped')
  })

  it('returns the curated speech-model catalog when the key is set', async () => {
    const { models, skipped } = await provider.listModels({
      ASSEMBLYAI_API_KEY: 'assemblyai-test',
    })
    expect(skipped).toBeUndefined()
    expect(models.map((m) => m.rawId)).toEqual([
      'universal-3-5-pro',
      'universal-2',
    ])
    expect(models.every((m) => m.activity === 'audio')).toBe(true)
  })
})

describe('assemblyai fetchSpec', () => {
  it('loads the public OpenAPI document without a key', async () => {
    const fixture = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'AssemblyAI API', version: '1.3.4' },
      paths: {
        '/v2/transcript': { post: { summary: 'Transcribe audio' } },
        '/v2/upload': { post: { summary: 'Upload a media file' } },
      },
    })
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(new Response(fixture))
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(urls).toEqual(['https://www.assemblyai.com/docs/openapi.json'])
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.specs).toHaveLength(1)
      expect(fetched.specs[0]?.info?.title).toBe('AssemblyAI API')
      expect(fetched.sources[0]?.url).toBe(
        'https://www.assemblyai.com/docs/openapi.json',
      )
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('assemblyai provider metadata', () => {
  it('exports the seed fields required for auto-registration', () => {
    expect(provider.id).toBe('assemblyai')
    expect(provider.displayName).toBe('AssemblyAI')
    expect(provider.authEnvVar).toBe('ASSEMBLYAI_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe(
      'https://www.assemblyai.com/docs/openapi.json',
    )
    expect(provider.modelsEndpoint).toBe(
      'https://api.assemblyai.com/v2/transcript',
    )
  })
})
