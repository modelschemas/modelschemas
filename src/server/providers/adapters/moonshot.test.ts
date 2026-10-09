import { KIMI_THINKING_URL } from '../provider-replay.ts'
import { KIMI_REPLAY_FIXTURE } from '../fixtures/provider-replay.ts'
import { describe, expect, it } from 'vitest'

import specFixture from '../fixtures/moonshotai-cn-openapi.json' with { type: 'json' }
import { provider } from './moonshot.ts'

const SPEC_URL = 'https://platform.kimi.ai/docs/openapi.json'

const FIXTURE_SPEC = {
  openapi: '3.1.0',
  info: { title: 'Moonshot AI API', version: '1.0.0' },
  servers: [{ url: 'https://api.moonshot.ai' }],
  paths: {
    '/v1/chat/completions': { post: { summary: 'Create Chat Completion' } },
    '/v1/files': { post: { summary: 'Upload File' } },
  },
}

describe('moonshot adapter', () => {
  it('exports seed metadata for the international host', () => {
    expect(provider.id).toBe('moonshot')
    expect(provider.displayName).toBe('Moonshot')
    expect(provider.authEnvVar).toBe('MOONSHOT_API_KEY')
    expect(provider.defaultDerivation).toBe('upstream-spec')
    expect(provider.specSourceUrl).toBe(SPEC_URL)
    expect(provider.modelsEndpoint).toBe('https://api.moonshot.ai/v1/models')
  })

  it('classifies chat completions and drops platform paths', () => {
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/files', {})).toBeNull()
    expect(provider.classify('/v1/batches', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.classify('/v1/users/me/balance', {})).toBeNull()
    expect(
      provider.classify('/v1/tokenizers/estimate-token-count', {}),
    ).toBeNull()
  })

  it('skips listModels when the secret is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toMatchObject([])
    expect(result.skipped).toBe('moonshot: MOONSHOT_API_KEY not set — skipped')
  })

  it('lists models from api.moonshot.ai, not the CN host', async () => {
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === KIMI_THINKING_URL)
        return Promise.resolve(new Response(KIMI_REPLAY_FIXTURE))
      if (String(url).includes('platform.kimi.ai')) {
        return Promise.resolve(
          new Response('["kimi-other","1M tokens",{"$"}0.1,{"$"}0.2,{"$"}0.3]'),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'kimi-k2.7-code', created: 1_786_418_420 }],
          }),
        ),
      )
    }) as typeof fetch
    try {
      const result = await provider.listModels({
        MOONSHOT_API_KEY: 'test-key',
      })
      expect(urls[0]).toBe('https://api.moonshot.ai/v1/models')
      expect(result.skipped).toBeUndefined()
      // The stub's spec is not a spec: the stored reasoning is kept.
      expect(result.models).toMatchObject([
        {
          rawId: 'kimi-k2.7-code',
          releasedAt: null,
          activity: 'chat',
          absent: { reasoning: 'unavailable', releasedAt: 'cleared' },
        },
      ])
      expect(result.docsFailures).toMatchObject({
        failed: 1,
        first: [{ source: SPEC_URL }],
      })
    } finally {
      globalThis.fetch = original
    }
  })

  it('reads each K2 model’s thinking switch from its own spec branch', async () => {
    // The international spec has the China spec's shape and names its own
    // server; the fixture is the China document with that one line changed.
    const spec = (server: string) =>
      JSON.stringify({ ...specFixture, servers: [{ url: server }] })
    const list = async (body: string) => {
      const original = globalThis.fetch
      globalThis.fetch = ((url: string) =>
        Promise.resolve(
          new Response(
            String(url) === KIMI_THINKING_URL
              ? KIMI_REPLAY_FIXTURE
              : String(url) === SPEC_URL
                ? body
                : String(url).includes('platform.kimi.ai')
                  ? '["kimi-other","1M tokens",{"$"}0.1,{"$"}0.2,{"$"}0.3]'
                  : JSON.stringify({
                      data: [
                        { id: 'kimi-k3' },
                        { id: 'kimi-k2.7-code' },
                        { id: 'kimi-k2.6' },
                        { id: 'moonshot-v1-8k' },
                      ],
                    }),
          ),
        )) as typeof fetch
      try {
        return await provider.listModels({ MOONSHOT_API_KEY: 'test-key' })
      } finally {
        globalThis.fetch = original
      }
    }

    const listed = await list(spec('https://api.moonshot.ai'))
    const byId = new Map(listed.models.map((model) => [model.rawId, model]))
    expect(listed.docsFailures).toMatchObject({ failed: 0 })
    expect(byId.get('kimi-k2.6')?.reasoning).toEqual({
      mode: 'toggle',
      mandatory: false,
    })
    expect(byId.get('kimi-k2.7-code')?.reasoning).toEqual({
      mode: 'toggle',
      mandatory: true,
    })
    expect(byId.get('kimi-k2.6')?.factSources).toMatchObject({
      reasoning: {
        derivation: 'upstream-spec',
        sourceUrl: SPEC_URL,
        sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        path: 'thinking.type',
      },
    })
    // Only the switch is taken from the spec; an effort row and an id the
    // spec does not map are left as the listing gave them.
    for (const id of ['kimi-k3', 'moonshot-v1-8k']) {
      expect(byId.get(id)).not.toHaveProperty('reasoning')
      expect(byId.get(id)?.factSources?.reasoning).toBeUndefined()
      expect(byId.get(id)?.absent).toEqual({ releasedAt: 'cleared' })
    }

    // The China host's document is not this provider's, and neither is a
    // 200 web page: every row keeps what is stored.
    for (const body of [
      spec('https://api.moonshot.cn'),
      '<!DOCTYPE html><html><body>Not found</body></html>',
    ]) {
      const failed = await list(body)
      expect(failed.docsFailures).toMatchObject({ failed: 1 })
      for (const model of failed.models) {
        expect(model.absent).toEqual({
          reasoning: 'unavailable',
          releasedAt: 'cleared',
        })
        expect(model).not.toHaveProperty('reasoning')
      }
    }
  })

  it('fetches the published spec without a key', async () => {
    const original = globalThis.fetch
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      return Promise.resolve(new Response(JSON.stringify(FIXTURE_SPEC)))
    }) as typeof fetch
    try {
      const fetched = await provider.fetchSpec({})
      expect(urls).toEqual([SPEC_URL])
      expect(fetched.outputStrategy).toBe('post-200')
      expect(fetched.sources).toHaveLength(1)
      expect(fetched.sources[0]?.url).toBe(SPEC_URL)
      expect(fetched.sources[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(fetched.specs[0]?.info?.title).toBe('Moonshot AI API')
    } finally {
      globalThis.fetch = original
    }
  })
})
