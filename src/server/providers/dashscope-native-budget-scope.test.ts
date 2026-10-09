import { expect, it } from 'vitest'
import docs from './fixtures/native-reasoning-docs.json'
import {
  applyDashscopeThinking,
  parseDashscopeThinking,
  DASHSCOPE_THINKING_URL,
} from './dashscope-thinking.ts'

it('reads mandatory budget mode only for native thinking-only models in explicit budget families', () => {
  const parsed = parseDashscopeThinking(docs[DASHSCOPE_THINKING_URL])
  for (const rawId of [
    'qwen3.7-max-2026-05-17',
    'qwen3.8-2.4t-a95b',
    'qwen3.6-35b-a3b',
    'qwen3.7-max-preview',
    'kimi-k2.7-code',
    'glm-5.3',
    'qwen3-next-80b-a3b-thinking',
    'qwen3-30b-a3b-thinking-2507',
    'qwen3-235b-a22b-thinking-2507',
  ]) {
    const model = applyDashscopeThinking(
      { rawId, activity: 'chat' },
      { ...parsed, hash: 'source' },
    )
    expect(model.reasoning).toEqual({
      mode: 'budget',
      mandatory: rawId === 'qwen3.6-35b-a3b' ? null : true,
    })
    expect(model.requestMap).toBeUndefined()
  }
  expect(
    applyDashscopeThinking(
      { rawId: 'qwq-plus', activity: 'chat' },
      { ...parsed, hash: 'source' },
    ).reasoning,
  ).toBeUndefined()
  expect(
    applyDashscopeThinking(
      { rawId: 'qwen3-unpublished', activity: 'chat' },
      { ...parsed, hash: 'source' },
    ).reasoning,
  ).toBeUndefined()
})
it('does not derive budget scope from code examples or malformed scope declarations', () => {
  const text = docs[DASHSCOPE_THINKING_URL]
  expect(() =>
    parseDashscopeThinking(
      text.replace(
        /Applicable to [^\n]+? series models\./,
        'Applicable to invalid family labels series models.',
      ),
    ),
  ).toThrow()
  expect(() =>
    parseDashscopeThinking(
      text.replace(/ {2}`thinking_budget`Parameter[^\n]+/, '```\n$&\n```'),
    ),
  ).toThrow()
})

it('rejects negated native budget applicability and thinking-only declarations', () => {
  const text = docs[DASHSCOPE_THINKING_URL]
  expect(() =>
    parseDashscopeThinking(
      text.replace(
        'Applicable to Qwen3.8',
        'Do not assume Applicable to Qwen3.8',
      ),
    ),
  ).toThrow('negated native budget')
  expect(() =>
    parseDashscopeThinking(
      text.replace(
        'Supports thinking mode only',
        'Does not support thinking mode only',
      ),
    ),
  ).toThrow('negated native model mode')
})
