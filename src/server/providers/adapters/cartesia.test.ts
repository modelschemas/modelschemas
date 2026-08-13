import { describe, expect, it } from 'vitest'

import {
  CARTESIA_SPEC_FALLBACK_URL,
  CARTESIA_STATS_URL,
  CARTESIA_VERSION,
  CARTESIA_VOICES_URL,
  provider,
} from './cartesia.ts'

const SPEC_FIXTURE = {
  openapi: '3.0.1',
  info: { title: 'Cartesia API', version: '0.0.1' },
  paths: {
    '/tts/bytes': { post: { operationId: 'tts_bytes' } },
    '/stt': { post: { operationId: 'stt_transcribe' } },
  },
}

async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response,
  run: () => Promise<T>,
): Promise<{ result: T; urls: Array<string> }> {
  const original = globalThis.fetch
  const urls: Array<string> = []
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const href = String(input)
    urls.push(href)
    return Promise.resolve(handler(href, init))
  }
  try {
    return { result: await run(), urls }
  } finally {
    globalThis.fetch = original
  }
}

describe('cartesia classify', () => {
  it('maps generation paths to audio and drops platform surfaces', () => {
    expect(provider.classify('/tts/bytes', {})).toBe('audio')
    expect(provider.classify('/tts/sse', {})).toBe('audio')
    expect(provider.classify('/stt', {})).toBe('audio')
    expect(provider.classify('/infill/bytes', {})).toBe('audio')
    expect(provider.classify('/voice-changer/bytes', {})).toBe('audio')
    expect(provider.classify('/audio/transcriptions', {})).toBe('audio')
    expect(provider.classify('/agents', {})).toBeNull()
    expect(provider.classify('/fine-tunes/', {})).toBeNull()
    expect(provider.classify('/datasets/', {})).toBeNull()
    expect(provider.classify('/voices/clone', {})).toBeNull()
    expect(provider.classify('/access-token', {})).toBeNull()
  })
})

describe('cartesia listModels', () => {
  it('skips when CARTESIA_API_KEY is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe('cartesia: CARTESIA_API_KEY not set — skipped')
  })

  it('lists voices with Cartesia-Version when a key is present', async () => {
    const { result, urls } = await withFetch(
      (url, init) => {
        expect(url.startsWith(CARTESIA_VOICES_URL)).toBe(true)
        const headers = new Headers(init?.headers)
        expect(headers.get('Authorization')).toBe('Bearer test-key')
        expect(headers.get('Cartesia-Version')).toBe(CARTESIA_VERSION)
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'voice-1',
                name: 'Guide',
                created_at: '2024-06-01T00:00:00Z',
              },
            ],
            has_more: false,
          }),
        )
      },
      () => provider.listModels({ CARTESIA_API_KEY: 'test-key' }),
    )
    expect(urls).toHaveLength(1)
    expect(result.skipped).toBeUndefined()
    expect(result.models).toEqual([
      {
        rawId: 'voice-1',
        displayName: 'Guide',
        activity: 'audio',
        releasedAt: Date.parse('2024-06-01T00:00:00Z') / 1000,
      },
    ])
  })
})

describe('cartesia fetchSpec', () => {
  it('resolves the Stainless spec URL from .stats.yml', async () => {
    const specUrl = 'https://example.test/cartesia-openapi.yml'
    const { result, urls } = await withFetch(
      (url) => {
        if (url === CARTESIA_STATS_URL) {
          return new Response(
            `configured_endpoints: 50\nopenapi_spec_url: ${specUrl}\n`,
          )
        }
        if (url === specUrl) {
          return new Response(JSON.stringify(SPEC_FIXTURE), {
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      },
      () => provider.fetchSpec({}),
    )
    expect(urls).toEqual([CARTESIA_STATS_URL, specUrl])
    expect(result.specs).toHaveLength(1)
    expect(result.sources[0]?.url).toBe(specUrl)
    expect(result.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.outputStrategy).toBe('post-200')
    expect(result.specRevision).toBe(specUrl)
    expect(result.warnings).toBeUndefined()
  })

  it('falls back to the last published spec when stats omit the URL', async () => {
    const { result, urls } = await withFetch(
      (url) => {
        if (url === CARTESIA_STATS_URL) {
          return new Response('configured_endpoints: 50\n')
        }
        if (url === CARTESIA_SPEC_FALLBACK_URL) {
          return new Response(JSON.stringify(SPEC_FIXTURE), {
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      },
      () => provider.fetchSpec({}),
    )
    expect(urls).toEqual([CARTESIA_STATS_URL, CARTESIA_SPEC_FALLBACK_URL])
    expect(result.sources[0]?.url).toBe(CARTESIA_SPEC_FALLBACK_URL)
    expect(result.warnings).toEqual([
      'cartesia: Stainless .stats.yml has no openapi_spec_url — using last published spec',
    ])
  })
})

describe('cartesia provider metadata', () => {
  it('exports the isolation contract', () => {
    expect(provider.id).toBe('cartesia')
    expect(provider.displayName).toBe('Cartesia')
    expect(provider.authEnvVar).toBe('CARTESIA_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toMatch(/^https:\/\//)
    expect(provider.modelsEndpoint).toBe(CARTESIA_VOICES_URL)
    expect(CARTESIA_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
