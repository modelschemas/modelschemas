import { afterEach, describe, expect, it } from 'vitest'

import { provider } from './google-vertex.ts'

function pricingUrl(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('source' in value)) {
    throw new Error('missing pricing')
  }
  const source = value.source
  if (typeof source !== 'object' || source === null || !('url' in source)) {
    throw new Error('missing pricing source')
  }
  if (typeof source.url !== 'string') throw new Error('missing pricing url')
  return source.url
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const LOCATIONS = `
<h2 id="google-models">Google model endpoint locations</h2>
<a href="/gemini-enterprise-agent-platform/models/gemini/3-1-pro">Gemini 3.1 Pro</a>
<code>(gemini-3.1-pro-preview)</code>
<h2 id="genai-partner-models">Partners</h2>
`

const CARD = `
<h1>Gemini 3.1 Pro</h1>
<p>Model ID</p><p>gemini-3.1-pro-preview</p>
<p>Modalities</p><p>Text</p><p>Input and output</p>
<p>Token limits</p>
<p>Context window</p><p>1,048,576</p>
<p>Maximum output tokens</p><p>65,536</p>
<p>Capabilities</p><p>Thinking</p><p>Supported</p>
<p>Tools</p><p>Function calling</p><p>Supported</p>
<p>Consumption options</p>
<p>Versions</p>
<p>gemini-3.1-pro-preview</p>
<p>Release date: February 19, 2026</p>
<p>Send feedback</p>
`

const THINKING = `
<table>
<tr><th>Model</th><th>Supported thinking_level values</th><th>Default</th></tr>
<tr><td>Gemini 3.1 Pro</td><td>LOW , MEDIUM , HIGH</td><td>HIGH</td></tr>
</table>
<p>You can't turn off thinking for Gemini 2.5 Pro.</p>
`

const PRICING = `
<table>
<tr>
<th>Model</th><th>Type</th><th>Region</th>
<th>Price (/1M tokens) &lt;= 200K input tokens</th>
<th>Price (/1M tokens) &gt; 200K input tokens</th>
<th>Price (/1M tokens) &lt;= 200K cached input tokens</th>
<th>Price (/1M tokens) &gt; 200K cached input tokens</th>
</tr>
<tr>
<td>Gemini 3.1 Pro</td>
<td>Input (text, image, video, audio)</td>
<td>Global</td><td>$2.00</td><td>$4.00</td><td>$0.20</td><td>$0.40</td>
</tr>
<tr>
<td></td>
<td>Text output (response and reasoning)</td>
<td>Global</td><td>$12.00</td><td>$18.00</td><td>N/A</td><td>N/A</td>
</tr>
</table>
`

const DISCOVERY = {
  title: 'Agent Platform API',
  version: 'v1',
  rootUrl: 'https://aiplatform.googleapis.com/',
  schemas: {
    Request: { type: 'object', properties: { body: { $ref: 'Body' } } },
    Body: { type: 'object' },
  },
  resources: {
    publishers: {
      resources: {
        models: {
          methods: {
            generateContent: {
              id: 'aiplatform.projects.locations.publishers.models.generateContent',
              flatPath:
                'v1/projects/{p}/locations/{l}/publishers/{pub}/models/{m}:generateContent',
              httpMethod: 'POST',
              request: { $ref: 'Request' },
              response: { $ref: 'Body' },
            },
          },
        },
      },
    },
  },
}

describe('google-vertex', () => {
  it('lists and specifies from Google docs, not an aggregator', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      urls.push(href)
      const body = href.includes('$discovery')
        ? JSON.stringify(DISCOVERY)
        : href.endsWith('/locations')
          ? LOCATIONS
          : href.endsWith('/thinking')
            ? THINKING
            : href.endsWith('/pricing')
              ? PRICING
              : CARD
      return Promise.resolve(new Response(body, { status: 200 }))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})
    const model = listed.models.find(
      (item) => item.rawId === 'gemini-3.1-pro-preview',
    )

    expect(listed.skipped).toBeUndefined()
    expect(model?.displayName).toBe('Gemini 3.1 Pro')
    expect(model?.contextWindow).toBe(1_048_576)
    expect(model?.reasoning).toEqual({
      mode: 'effort',
      mandatory: true,
      efforts: ['LOW', 'MEDIUM', 'HIGH'],
    })
    expect(pricingUrl(model?.pricing)).toContain('generative-ai/pricing')
    expect(spec.specs[0]?.paths).toHaveProperty(
      '/v1/projects/{p}/locations/{l}/publishers/{pub}/models/{m}:generateContent',
    )
    expect(provider.displayName).toBe('Gemini Enterprise Agent Platform')
    expect(provider.id).toBe('google-vertex')
    expect(urls.some((url) => /models\.dev|openrouter/i.test(url))).toBe(false)
    expect(
      provider.classify(
        '/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:embedContent',
        {},
      ),
    ).toBe('embeddings')
  })
})
