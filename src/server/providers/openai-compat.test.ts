import { describe, expect, it } from 'vitest'

import { classifyOpenAiCompat, filterOpenAiSpec } from './openai-compat.ts'
import type { OpenApiDocument } from './types.ts'

const spec: OpenApiDocument = {
  info: { title: 'OpenAI API', version: '2.3.0' },
  servers: [{ url: 'https://api.openai.com/v1' }],
  paths: {
    '/chat/completions': { post: { operationId: 'createChat' } },
    '/embeddings': { post: { operationId: 'createEmbedding' } },
    '/files': { get: { operationId: 'listFiles' } },
  },
}

describe('filterOpenAiSpec', () => {
  it('keeps only requested paths and rewrites title + servers', () => {
    const filtered = filterOpenAiSpec(spec, {
      title: 'Groq',
      serverUrl: 'https://api.groq.com/openai/v1',
      include: ['/chat/completions', '/embeddings'],
    })
    expect(filtered.info?.title).toBe('Groq')
    expect(filtered.servers).toEqual([
      { url: 'https://api.groq.com/openai/v1' },
    ])
    expect(Object.keys(filtered.paths ?? {})).toEqual([
      '/chat/completions',
      '/embeddings',
    ])
    expect(filtered.paths?.['/files']).toBeUndefined()
  })

  it('silently drops include entries the upstream spec lacks', () => {
    const filtered = filterOpenAiSpec(spec, {
      title: 'Thin',
      serverUrl: 'https://example.test/v1',
      include: ['/chat/completions', '/videos'],
    })
    expect(Object.keys(filtered.paths ?? {})).toEqual(['/chat/completions'])
  })
})

describe('classifyOpenAiCompat', () => {
  it('maps generation paths, with or without a /v1 prefix', () => {
    expect(classifyOpenAiCompat('/chat/completions')).toBe('chat')
    expect(classifyOpenAiCompat('/v1/chat/completions')).toBe('chat')
    expect(classifyOpenAiCompat('/embeddings')).toBe('embeddings')
    expect(classifyOpenAiCompat('/audio/speech')).toBe('audio')
    expect(classifyOpenAiCompat('/images/generations')).toBe('image')
    expect(classifyOpenAiCompat('/moderations')).toBe('moderation')
    expect(classifyOpenAiCompat('/files')).toBeNull()
    expect(classifyOpenAiCompat('/v1/models')).toBeNull()
  })
})
