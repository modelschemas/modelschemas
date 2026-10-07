import { describe, expect, it } from 'vitest'

import {
  dashscopeCompatCovers,
  parseDashscopeCompat,
  parseDashscopeCompatScope,
} from './dashscope-compat.ts'

/**
 * Request-parameter rows from
 * compatibility-of-openai-with-dashscope.md, checked 2026-10-08.
 * top_p says "keeps only the smallest set" and is not model-restricted.
 * The Supported models line is the page's own compat scope.
 */
const COMPAT_FIXTURE = `
Supported models: Qwen large language models (commercial and open-source editions), Qwen-VL, Qwen-Coder, Qwen-Omni, Qwen-Math, DeepSeek, Kimi, GLM, MiniMax.
Qwen-Audio does not support the OpenAI compatible protocol.

## Request parameters

The request parameters are aligned with the OpenAI interface.

<table><tbody>
<tr><td><p>model</p></td><td><p>string</p></td><td><p>-</p></td><td><p>The model to use.</p></td></tr>
<tr><td><p>messages</p></td><td><p>array</p></td><td><p>-</p></td><td><p>Valid roles: system, user, assistant. Only messages[0] supports the system role.</p></td></tr>
<tr><td><p>top_p</p></td><td><p>float</p></td><td><p>-</p></td><td><p>For example, a value of 0.8 keeps only the smallest set of tokens whose cumulative probability is at least 0.8.</p></td></tr>
<tr><td><p>temperature</p></td><td><p>float</p></td><td><p>-</p></td><td><p>Controls the randomness and diversity of model responses.</p></td></tr>
<tr><td><p>presence_penalty</p></td><td><p>float</p></td><td><p>-</p></td><td><p>Supported only on Qwen commercial models and open-source models qwen1.5 and later.</p></td></tr>
<tr><td><p>n</p></td><td><p>integer</p></td><td><p>-</p></td><td><p>Currently supported only on qwen-plus.</p></td></tr>
<tr><td><p>max_tokens</p></td><td><p>integer</p></td><td><p>-</p></td><td><p>The maximum number of tokens the model can generate.</p></td></tr>
<tr><td><p>seed</p></td><td><p>integer</p></td><td><p>-</p></td><td><p>The random seed for generation.</p></td></tr>
<tr><td><p>stop</p></td><td><p>string or array</p></td><td><p>-</p></td><td><p>Controls precise stopping of content generation.</p></td></tr>
<tr><td><p>tools</p></td><td><p>array</p></td><td><p>-</p></td><td><p>Currently supported models: qwen-turbo, qwen-plus, and qwen-max.</p></td></tr>
</tbody></table>

## Response parameters
`

describe('parseDashscopeCompat', () => {
  it('maps unrestricted request parameters and leaves developer off', async () => {
    const facts = await parseDashscopeCompat(COMPAT_FIXTURE)
    expect(facts.flags).toEqual([
      'top_p',
      'temperature',
      'max_tokens',
      'seed',
      'stop',
    ])
    expect(facts.requestMap).toEqual({
      thinking: null,
      maxTokensField: 'max_tokens',
      developerRole: false,
      replayReasoningContent: null,
      store: null,
      strictTools: null,
      sessionAffinity: null,
      cacheControl: null,
      toolStream: null,
      reasoningEffort: null,
    })
    expect(facts.sourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(facts.scope).toEqual({
      qwenLlm: true,
      qwenKinds: ['vl', 'coder', 'omni', 'math'],
      families: ['deepseek', 'kimi', 'glm', 'minimax'],
      deny: ['audio'],
    })
    const scope = parseDashscopeCompatScope(COMPAT_FIXTURE)
    for (const id of [
      'qwen-plus',
      'qwen3-omni-flash',
      'deepseek-v4.1-flash',
      'glm-5',
      'kimi-k2',
      'minimax-m2',
    ]) {
      expect(dashscopeCompatCovers(id, scope)).toBe(true)
    }
    expect(dashscopeCompatCovers('decision-model-preview', scope)).toBe(false)
    expect(dashscopeCompatCovers('qwen-audio-turbo', scope)).toBe(false)
  })

  it('throws when the request table is missing', async () => {
    await expect(parseDashscopeCompat('# no table')).rejects.toThrow(
      /parsed 0 request parameters|no request-parameter section/,
    )
  })
})
