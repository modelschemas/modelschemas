import { describe, expect, it } from 'vitest'

import { chatRequestMap } from './request-map.ts'

describe('chatRequestMap', () => {
  it('sends OpenAI reasoning_effort and the gpt-5.1 level map', () => {
    const map = chatRequestMap('openai', 'gpt-5.1', 'chat')
    expect(map?.thinking?.on).toEqual({ reasoning_effort: 'high' })
    expect(map?.thinking?.off).toBeNull()
    expect(map?.thinking?.levels).toEqual({
      off: 'none',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null,
    })
    expect(map?.maxTokensField).toBe('max_completion_tokens')
    expect(map?.developerRole).toBe(true)
    expect(map?.reasoningEffort).toBe(true)
  })

  it('sends DeepSeek thinking plus reasoning_effort, and replays reasoning_content', () => {
    const map = chatRequestMap('deepseek', 'deepseek-chat', 'chat')
    expect(map?.thinking?.on).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
    expect(map?.thinking?.off).toEqual({ thinking: { type: 'disabled' } })
    expect(map?.maxTokensField).toBe('max_tokens')
    expect(map?.developerRole).toBe(false)
    expect(map?.replayReasoningContent).toBe(true)
  })

  it('omits unsupported deepseek-flash levels, including medium', () => {
    const map = chatRequestMap('deepseek', 'deepseek-flash', 'chat')
    expect(map?.thinking?.levels).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    })
    expect(map?.replayReasoningContent).toBe(true)
  })

  it('sends GLM thinking on and the glm-5.2 level map', () => {
    const map = chatRequestMap('zai', 'glm-5.2', 'chat')
    expect(map?.thinking?.on).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
    })
    expect(map?.thinking?.levels).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    })
    expect(map?.maxTokensField).toBe('max_tokens')
    expect(map?.developerRole).toBe(false)
    expect(map?.toolStream).toBe(true)
    expect(map?.reasoningEffort).toBe(true)
  })

  it('leaves GLM flags the Z.AI spec does not state as null', () => {
    const flash = chatRequestMap('zai', 'glm-5.3-flashx', 'chat')
    expect(flash?.thinking?.levels).toMatchObject({
      low: 'low',
      medium: null,
      high: 'high',
      max: 'max',
    })
    expect(flash?.reasoningEffort).toBe(true)
    expect(flash?.toolStream).toBe(true)
    // GLM-5.3 and GLM-5.3-FLASH "can only be enabled": there is no off body.
    expect(flash?.thinking?.off).toBeNull()
    expect(chatRequestMap('zai', 'glm-5.3', 'chat')?.thinking?.off).toBeNull()
    // Every other thinking model takes `thinking.type: disabled`.
    for (const id of ['glm-5.2', 'glm-5', 'glm-4.7-flash', 'glm-4.6v']) {
      expect(chatRequestMap('zai', id, 'chat')?.thinking?.off).toEqual({
        thinking: { type: 'disabled' },
      })
    }

    // glm-5 is not glm-5.2: no effort field, but it is a tool_stream series.
    const five = chatRequestMap('zai', 'glm-5', 'chat')
    expect(five?.thinking?.levels).toBeNull()
    expect(five?.reasoningEffort).toBeNull()
    expect(five?.toolStream).toBe(true)

    const air = chatRequestMap('zai', 'glm-4.5-air', 'chat')
    expect(air?.thinking?.on).toEqual({
      thinking: { type: 'enabled', clear_thinking: false },
    })
    expect(air?.toolStream).toBeNull()
    expect(air?.reasoningEffort).toBeNull()

    // glm-4.6v is not the glm-4.6 series.
    expect(chatRequestMap('zai', 'glm-4.6v', 'chat')?.toolStream).toBeNull()

    const legacy = chatRequestMap('zai', 'glm-4-32b-0414-128k', 'chat')
    expect(legacy?.thinking).toBeNull()
    expect(legacy?.maxTokensField).toBe('max_tokens')
  })

  it('sends Qwen enable_thinking and the vLLM kwargs body', () => {
    expect(chatRequestMap('qwen', 'qwen3', 'chat')?.thinking?.on).toEqual({
      enable_thinking: true,
    })
    expect(chatRequestMap('vllm', 'qwen3', 'chat')?.thinking?.on).toEqual({
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: true,
      },
    })
  })

  it('sends OpenRouter and Together thinking-on bodies', () => {
    const openrouter = chatRequestMap('openrouter', 'openai/gpt-5.1', 'chat')
    expect(openrouter?.thinking?.on).toEqual({ reasoning: { effort: 'high' } })
    expect(openrouter?.thinking?.levels ?? null).toBeNull()
    expect(openrouter?.sessionAffinity).toBe(true)
    expect(
      chatRequestMap('openrouter', 'anthropic/claude-opus-4', 'chat')
        ?.cacheControl,
    ).toBe('anthropic')

    const together = chatRequestMap(
      'together',
      'deepseek-ai/DeepSeek-V3',
      'chat',
    )
    expect(together?.thinking?.on).toEqual({ reasoning: { enabled: true } })
    expect(together?.maxTokensField).toBe('max_tokens')
    expect(together?.developerRole).toBe(false)
    expect(together?.reasoningEffort).toBe(false)
  })

  it('names max_tokens and rejects reasoning_effort where the docs do', () => {
    for (const provider of ['moonshot', 'nvidia', 'cloudflare'] as const) {
      const map = chatRequestMap(provider, 'some-chat', 'chat')
      expect(map?.maxTokensField).toBe('max_tokens')
      expect(map?.reasoningEffort).toBe(false)
      expect(map?.developerRole).toBe(false)
      expect(map?.thinking).toBeNull()
    }
    expect(chatRequestMap('grok', 'grok-4', 'chat')?.reasoningEffort).toBe(
      false,
    )
  })

  it('returns null for an unverified provider, a non-chat row, and an unknown activity', () => {
    expect(chatRequestMap('fal', 'fal-ai/flux', 'chat')).toBeNull()
    expect(chatRequestMap('byteplus', 'glm-5-2-260617', 'chat')).toBeNull()
    expect(chatRequestMap('openai', 'gpt-5.1', 'image')).toBeNull()
    expect(chatRequestMap('deepseek', 'deepseek-flash', null)).toBeNull()
  })
})
