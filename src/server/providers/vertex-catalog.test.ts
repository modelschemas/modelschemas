import { describe, expect, it } from 'vitest'

import {
  parseCard,
  parseLocationModels,
  parseThinking,
  vertexActivity,
  vertexEndpoint,
} from './vertex-catalog.ts'

const LOCATIONS = `
<h2 id="google-models" data-text="Google model endpoint locations">Google model endpoint locations</h2>
<a href="/gemini-enterprise-agent-platform/models/gemini/3-1-pro">Gemini 3.1 Pro</a>
<code>(gemini-3.1-pro-preview)</code>
<a href="/gemini-enterprise-agent-platform/models/gemini/3-5-transcribe">Transcribe</a>
<code>(['gemini-3.5-transcribe', 'gemini-3.5-transcribe-live'])</code>
<code>(chirp_3)</code>
<a href="/speech-to-text/docs/models/chirp-3">Chirp</a>
<h2 id="genai-partner-models">Google Cloud partner model endpoint locations</h2>
<a href="/gemini-enterprise-agent-platform/models/partner-models/claude">Claude</a>
<code>(claude-sonnet-4-5)</code>
`

const CARD = `
<h1 class="devsite-page-title">
  Gemini 3.1 Pro<devsite-actions hidden data-nosnippet>
    <span slot="popout-heading">Stay organized with collections</span>
    <span slot="popout-contents">Save and categorize content based on your preferences.</span>
  </devsite-actions>
</h1>
<p>Model ID</p>
<p>gemini-3.1-pro-preview</p>
<p>Modalities</p>
<p>description</p><p>Text</p><p>Input and output</p>
<p>photo</p><p>Image</p><p>Input only</p>
<p>mic</p><p>Audio</p><p>Not supported</p>
<p>Token limits</p>
<p>Context window</p><p>1,048,576</p>
<p>Maximum output tokens</p><p>65,536</p>
<p>Capabilities</p>
<p>Thinking</p><p>Supported</p>
<p>Structured output</p><p>Supported</p>
<p>URL context</p><p>Supported</p>
<p>Tools</p>
<p>Grounding</p>
<p>Google Search, Parallel Web Search</p>
<p>Supported</p>
<p>Code execution</p><p>Supported</p>
<p>Function calling</p><p>Supported</p>
<p>Computer use</p><p>preview</p><p>Preview feature</p><p>Not supported</p>
<p>Consumption options</p>
<p>Temperature: 0.0-2.0 (default 1.0)</p>
<p>topP: 0.0-1.0 (default 0.95)</p>
<p>topK: 64 (fixed)</p>
<p>Versions</p>
<p>gemini-3.1-pro-preview</p>
<p>Launch stage: Public preview</p>
<p>Release date: February 19, 2026</p>
<p>gemini-3.1-pro-preview-customtools*</p>
<p>Launch stage: Public preview</p>
<p>Release date: February 23, 2026</p>
<p>Send feedback</p>
`

const THINKING = `
<table>
<tr><th>Model</th><th>Supported thinking_level values</th><th>Default</th></tr>
<tr><td>Gemini 3.1 Pro preview</td><td>LOW , MEDIUM , HIGH</td><td>HIGH</td></tr>
<tr><td>Gemini 3 Pro Image</td><td>HIGH</td><td>HIGH</td></tr>
</table>
<table>
<tr><th>Model</th><th>Minimum tokens</th><th>Maximum tokens</th></tr>
<tr><td>Gemini 2.5 Flash</td><td>1</td><td>24,576</td></tr>
<tr><td>Gemini 2.5 Pro</td><td>128</td><td>32,768</td></tr>
</table>
<p>You can turn off thinking for Gemini 2.5 Flash and Gemini 2.5 Flash-Lite by setting thinking_budget to 0.</p>
<p>You can't turn off thinking for Gemini 2.5 Pro.</p>
`

describe('vertex locations', () => {
  it('reads Google model ids and drops Chirp and partner models', () => {
    expect(parseLocationModels(LOCATIONS)).toEqual([
      {
        rawId: 'gemini-3.1-pro-preview',
        cardPath: '/gemini-enterprise-agent-platform/models/gemini/3-1-pro',
      },
      {
        rawId: 'gemini-3.5-transcribe',
        cardPath:
          '/gemini-enterprise-agent-platform/models/gemini/3-5-transcribe',
      },
      {
        rawId: 'gemini-3.5-transcribe-live',
        cardPath:
          '/gemini-enterprise-agent-platform/models/gemini/3-5-transcribe',
      },
    ])
  })
})

describe('vertex model card', () => {
  it('reads limits, modalities, tools, and version dates', () => {
    const card = parseCard(CARD)
    expect(card.title).toBe('Gemini 3.1 Pro')
    expect(card.modelId).toBe('gemini-3.1-pro-preview')
    expect(card.contextWindow).toBe(1_048_576)
    expect(card.maxOutput).toBe(65_536)
    expect(card.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })
    expect(card.capabilities).toEqual([
      'structured_outputs',
      'tools',
      'temperature',
      'top_p',
      'top_k',
    ])
    expect(card.serverTools).toEqual([
      'googleSearch',
      'codeExecution',
      'urlContext',
    ])
    expect(card.thinkingSupported).toBe(true)
    expect(card.versions).toEqual([
      {
        rawId: 'gemini-3.1-pro-preview',
        releasedAt: Date.UTC(2026, 1, 19) / 1000,
        deprecated: false,
      },
      {
        rawId: 'gemini-3.1-pro-preview-customtools',
        releasedAt: Date.UTC(2026, 1, 23) / 1000,
        deprecated: false,
      },
    ])
  })
})

describe('vertex thinking', () => {
  it('maps thinking_level and which 2.5 models can disable a budget', () => {
    const thinking = parseThinking(THINKING)
    expect(thinking.effort.get('gemini 3 1 pro')).toEqual([
      'LOW',
      'MEDIUM',
      'HIGH',
    ])
    expect(thinking.effort.get('gemini 3 pro image')).toEqual(['HIGH'])
    expect(thinking.budgetOff.has('gemini 2 5 flash')).toBe(true)
    expect(thinking.budgetOff.has('gemini 2 5 flash lite')).toBe(true)
    expect(thinking.budgetOn.has('gemini 2 5 pro')).toBe(true)
  })
})

describe('vertex routes', () => {
  it('binds generation, predict, and embed by id', () => {
    expect(vertexActivity('gemini-3.1-pro-preview')).toBe('chat')
    expect(vertexActivity('gemini-3-pro-image')).toBe('image')
    expect(vertexActivity('veo-3.1-generate-001')).toBe('video')
    expect(vertexActivity('gemini-embedding-001')).toBe('embeddings')
    expect(vertexActivity('gemini-2.5-flash-tts')).toBe('audio')
    expect(vertexEndpoint('virtual-try-on-001')).toContain(':predict')
    expect(vertexEndpoint('veo-3.1-generate-001')).toContain(
      ':predictLongRunning',
    )
    expect(vertexEndpoint('gemini-3-pro-image')).toContain(':generateContent')
  })
})
