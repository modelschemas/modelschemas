import { requestUrl } from '#/lib/text.ts'
import { describe, expect, it } from 'vitest'

import {
  CARTESIA_API_INDEX_URL,
  CARTESIA_VERSION,
  CARTESIA_VOICES_URL,
  provider,
} from './cartesia.ts'

const PAGE = `https://docs.cartesia.ai/${CARTESIA_VERSION}/api-reference`
const TTS_PAGE = `${PAGE}/tts/bytes.md`
const STT_PAGE = `${PAGE}/stt/transcribe.md`
const WS_PAGE = `${PAGE}/tts/websocket.md`

const INDEX = [
  `- [TTS](${TTS_PAGE}): Stream audio`,
  `- [STT](${STT_PAGE})`,
  `- [TTS WS](${WS_PAGE})`,
  `- [Old](https://docs.cartesia.ai/api-reference/tts/bytes.md)`,
  `- [JA](https://docs.cartesia.ai/ja-jp/api-reference/tts/bytes.md)`,
].join('\n')

const block = (op: string, yaml: string) =>
  `# Page\n\n## OpenAPI\n\n\`\`\`\`yaml ${CARTESIA_VERSION}/api.yml ${op}\n${yaml}\`\`\`\`\n`

const TTS_MD = block(
  'POST /tts/bytes',
  `openapi: 3.0.1
info:
  title: Cartesia API
  version: 0.0.1
paths:
  /tts/bytes:
    post:
      operationId: tts_bytes
components:
  schemas:
    VoiceId:
      type: string
`,
)
const STT_MD = block(
  'POST /stt',
  `openapi: 3.0.1
info:
  title: Cartesia API
  version: 0.0.1
paths:
  /stt:
    post:
      operationId: stt_transcribe
components:
  schemas:
    VoiceId:
      type: string
    STTModel:
      type: string
`,
)
const WS_MD = `## AsyncAPI\n\n\`\`\`\`yaml ${CARTESIA_VERSION}/asyncapi.yml /tts/websocket\nasyncapi: 3.0.0\n\`\`\`\`\n`

async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response,
  run: () => Promise<T>,
): Promise<{ result: T; urls: Array<string> }> {
  const original = globalThis.fetch
  const urls: Array<string> = []
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const href = requestUrl(input)
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
        modalities: { input: ['text'], output: ['audio'] },
        releasedAt: Date.parse('2024-06-01T00:00:00Z') / 1000,
      },
    ])
  })
})

describe('cartesia fetchSpec', () => {
  const pages = (overrides: Record<string, string> = {}) => {
    const bodies: Record<string, string> = {
      [CARTESIA_API_INDEX_URL]: INDEX,
      [TTS_PAGE]: TTS_MD,
      [STT_PAGE]: STT_MD,
      [WS_PAGE]: WS_MD,
      ...overrides,
    }
    return (url: string) =>
      url in bodies
        ? new Response(bodies[url])
        : new Response('not found', { status: 404 })
  }

  it('merges the versioned API pages into one OpenAPI document', async () => {
    const { result, urls } = await withFetch(pages(), () =>
      provider.fetchSpec({}),
    )
    expect(urls[0]).toBe(CARTESIA_API_INDEX_URL)
    expect(urls.slice(1).sort()).toEqual([STT_PAGE, TTS_PAGE, WS_PAGE])
    const spec = result.specs[0]
    expect(Object.keys(spec?.paths ?? {}).sort()).toEqual([
      '/stt',
      '/tts/bytes',
    ])
    expect(spec?.components).toEqual({
      schemas: { VoiceId: { type: 'string' }, STTModel: { type: 'string' } },
    })
    expect(result.sources).toEqual([
      { url: CARTESIA_API_INDEX_URL, hash: result.specRevision },
    ])
    expect(result.specRevision).toMatch(/^[0-9a-f]{64}$/)
    expect(result.outputStrategy).toBe('post-200')
  })

  it('throws when two pages disagree on a component', async () => {
    const conflicting = STT_MD.replace(
      'VoiceId:\n      type: string',
      'VoiceId:\n      type: integer',
    )
    await expect(
      withFetch(pages({ [STT_PAGE]: conflicting }), () =>
        provider.fetchSpec({}),
      ),
    ).rejects.toThrow('components.schemas VoiceId differs between API pages')
  })

  it('throws when a page fetch fails', async () => {
    await expect(
      withFetch(
        (url) =>
          url === CARTESIA_API_INDEX_URL
            ? new Response(INDEX)
            : new Response('denied', { status: 403 }),
        () => provider.fetchSpec({}),
      ),
    ).rejects.toThrow('403')
  })

  it('throws when the index lists no versioned pages', async () => {
    await expect(
      withFetch(pages({ [CARTESIA_API_INDEX_URL]: '# empty' }), () =>
        provider.fetchSpec({}),
      ),
    ).rejects.toThrow('cartesia: no')
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
