import { expect, it } from 'vitest'
import {
  parseTogetherGptOssFamily,
  togetherGptOssFamilyMatches,
  parseTogetherNamedHybrid,
  parseTogetherFamilyThinking,
  applyTogetherDocs,
  reasoningHit,
  togetherNamedHybridMatches,
} from './together-facts.ts'
import docs from './fixtures/together-gpt-oss-native-family.json'

it('reads native family-wide effort contract and normative values', () => {
  expect(parseTogetherGptOssFamily(docs.markdown)).toEqual({
    mode: 'effort',
    mandatory: null,
    efforts: ['low', 'medium', 'high'],
  })
  expect(togetherGptOssFamilyMatches('OpenAI GPT-OSS 20B')).toBe(true)
  expect(togetherGptOssFamilyMatches('GPT-OSS 120B')).toBe(true)
  expect(togetherGptOssFamilyMatches('OpenAI GPT-OSS 20B Fine Tune')).toBe(
    false,
  )
  expect(togetherGptOssFamilyMatches(null)).toBe(false)
})
it('does not use fenced or negated family prose or example effort levels', () => {
  expect(
    parseTogetherGptOssFamily('```\n' + docs.markdown + '\n```'),
  ).toBeNull()
  expect(
    parseTogetherGptOssFamily(
      docs.markdown.replace(
        'GPT-OSS models support a',
        'Do not assume GPT-OSS models support a',
      ),
    ),
  ).toBeNull()
  expect(() =>
    parseTogetherGptOssFamily(
      docs.markdown.replace(
        'Supports the `reasoning_effort` parameter to control reasoning depth',
        'Unpublished effort values',
      ),
    ),
  ).toThrow('effort values missing')
})

it('requires exact native named hybrid identity and operational disable proof', () => {
  const parsed = parseTogetherNamedHybrid(docs.markdown)
  expect(parsed).toEqual({
    nativeBasename: 'DeepSeek-V3.1',
    reasoning: { mode: 'toggle', mandatory: false },
  })
  expect(
    togetherNamedHybridMatches(
      'deepseek-ai/DeepSeek-V3.1',
      parsed!.nativeBasename,
    ),
  ).toBe(true)
  expect(
    togetherNamedHybridMatches(
      'deepseek-ai/DeepSeek-V3.1-NVFP4',
      parsed!.nativeBasename,
    ),
  ).toBe(false)
  expect(
    togetherNamedHybridMatches(
      'deepseek-ai/DeepSeek-V3.2',
      parsed!.nativeBasename,
    ),
  ).toBe(false)
  expect(parseTogetherNamedHybrid('```\n' + docs.markdown + '\n```')).toBeNull()
  expect(() =>
    parseTogetherNamedHybrid(
      docs.markdown.replace(
        'For DeepSeek V3.1, function calling only works',
        'Do not assume For DeepSeek V3.1, function calling only works',
      ),
    ),
  ).toThrow()
  expect(() =>
    parseTogetherNamedHybrid(
      docs.markdown.replace(
        'Supports both reasoning and non-reasoning modes',
        'Never assume Supports both reasoning and non-reasoning modes',
      ),
    ),
  ).toThrow()
})

it('extracts own normative effort and hybrid wire fields without generic fallbacks', () => {
  expect(parseTogetherFamilyThinking(docs.markdown)).toEqual({
    effort: { on: { reasoning_effort: 'high' }, off: null, levels: null },
    hybrid: {
      on: { reasoning: { enabled: true } },
      off: { reasoning: { enabled: false } },
      levels: null,
    },
  })
  expect(
    parseTogetherFamilyThinking('```\n' + docs.markdown + '\n```'),
  ).toEqual({ effort: null, hybrid: null })
})

it('retains source-only wire maps on new family models with unrelated flags unknown', () => {
  const wire = parseTogetherFamilyThinking(docs.markdown)
  const own = parseTogetherGptOssFamily(docs.markdown)!
  const next = applyTogetherDocs(
    {
      rawId: 'openai/gpt-oss-20b',
      displayName: 'OpenAI GPT-OSS 20B',
      activity: 'chat',
    },
    null,
    new Map([
      [
        'openai/gpt-oss-20b',
        reasoningHit(own, docs.sourceUrl, 'native-source-hash', wire.effort),
      ],
    ]),
    { loaded: true, hash: 'native-source-hash' },
  )
  expect(next.reasoning).toEqual(own)
  expect(next.requestMap?.thinking?.on).toEqual({ reasoning_effort: 'high' })
  expect(next.requestMap?.thinking?.off).toBeNull()
  expect(next.requestMap?.strictTools).toBeNull()
  expect(next.factSources?.requestMapFields?.thinking).toMatchObject({
    sourceUrl: docs.sourceUrl,
    sourceHash: 'native-source-hash',
  })
})

it('preserves explicit capability flags and rejects contradictory negative reasoning', () => {
  const native = parseTogetherGptOssFamily(docs.markdown)!
  const hits = new Map([
    ['openai/gpt-oss-20b', reasoningHit(native, docs.sourceUrl, 'hash')],
  ])
  const base = {
    rawId: 'openai/gpt-oss-20b',
    activity: 'chat' as const,
    capabilities: { tools: false, structured_outputs: true },
  }
  expect(
    applyTogetherDocs(base, null, hits, { loaded: true, hash: 'hash' })
      .capabilities,
  ).toEqual({ tools: false, structured_outputs: true, reasoning: true })
  expect(() =>
    applyTogetherDocs(
      { ...base, capabilities: { reasoning: false } },
      null,
      hits,
      { loaded: true, hash: 'hash' },
    ),
  ).toThrow('explicit reasoning rejection')
  expect(() =>
    applyTogetherDocs(
      { ...base, unsupportedCapabilities: ['reasoning'] },
      null,
      hits,
      { loaded: true, hash: 'hash' },
    ),
  ).toThrow('explicit reasoning rejection')
})

it('retains explicit null thinking when native effort levels cannot source high', () => {
  const wire = parseTogetherFamilyThinking(
    docs.markdown.replace(
      '`"low"`, `"medium"`, or `"high"`',
      '`"low"` or `"medium"`',
    ),
  )
  expect(wire.effort).toBeNull()
  const next = applyTogetherDocs(
    { rawId: 'openai/gpt-oss-20b', activity: 'chat' },
    null,
    new Map([
      [
        'openai/gpt-oss-20b',
        reasoningHit(
          { mode: 'effort', mandatory: null, efforts: ['low', 'medium'] },
          docs.sourceUrl,
          'hash',
          wire.effort,
        ),
      ],
    ]),
    { loaded: true, hash: 'hash' },
  )
  expect(next.requestMap?.thinking).toBeNull()
  expect(next.requestMap?.strictTools).toBeNull()
})
