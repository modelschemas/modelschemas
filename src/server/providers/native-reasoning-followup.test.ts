import { afterEach, expect, it } from 'vitest'
import awsDocs from './fixtures/native-reasoning-followup.json'
import { bedrockReasoning, parseBedrockCard } from './bedrock-cards.ts'
import {
  openaiModelFacts,
  OPENAI_MODELS_INDEX_URL,
  OPENAI_PRICING_URL,
} from './openai-model-docs.ts'
import { keepValidReasoning } from './reasoning-config.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const source = (id: string) => ({
  url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/' + id,
  hash: 'h',
  extractedAt: 't',
})
it('keeps mandatory unknown when native AWS cards only state defaults or effort names', () => {
  expect(
    parseBedrockCard(
      awsDocs['model-card-anthropic-claude-sonnet-5-5.md'],
      source('sonnet'),
    )?.reasoning?.mandatory,
  ).toBeNull()
  expect(
    parseBedrockCard(awsDocs['model-card-xai-grok-4-6.md'], source('grok'))
      ?.reasoning?.mandatory,
  ).toBeNull()
  expect(
    parseBedrockCard(
      awsDocs['model-card-anthropic-claude-haiku-5-5.md'],
      source('haiku'),
    )?.reasoning?.mandatory,
  ).toBe(false)
  expect(
    parseBedrockCard(
      awsDocs['model-card-anthropic-claude-mythos-5-1.md'],
      source('mythos'),
    )?.reasoning?.mandatory,
  ).toBe(true)
  expect(
    bedrockReasoning('Supported (adaptive thinking is on by default)'),
  ).toEqual({ mode: 'adaptive', mandatory: null })
  expect(
    bedrockReasoning(
      'Supported (configurable: low, high; cannot be turned off)',
    )?.mandatory,
  ).toBe(true)
  expect(
    bedrockReasoning('Supported (configurable: low, high; can be turned off)')
      ?.mandatory,
  ).toBe(false)
})
it('reads AWS reasoning capability ticks without manufacturing controls', () => {
  for (const id of ['model-card-google-gemma-4-31b.md'] as const) {
    const parsed = parseBedrockCard(awsDocs[id], source(id))
    expect(parsed?.capabilities).toContain('reasoning')
    expect(parsed?.reasoning).toBeNull()
  }
})
it('ignores illustrative AWS effort values without a native normative declaration', () => {
  const card =
    awsDocs['model-card-openai-gpt-6-1-sol.md'] +
    '\n**Reasoning effort**\n\nFor example, try `low` or `high`.\n```\nSet reasoning effort to `none`, `max`.\n```\n'
  expect(parseBedrockCard(card, source('example'))?.reasoning).toBeNull()
})
it('clears prior guessed reasoning when fresh docs contain no sourced control', () => {
  const fresh = { rawId: 'o3', reasoning: null }
  expect(
    keepValidReasoning('openai', fresh, {
      reasoning: { mode: 'effort', mandatory: true, efforts: ['low', 'high'] },
      factSources: null,
    }).reasoning,
  ).toBeNull()
})
const pricing = `Specialized models

Prices per 1M tokens.

Standard

### Grouped Pricing Table data

| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| Search | gpt-5-search-api | $1.25 | $0.125 | $10.00 |
`
for (const malformed of [false, true])
  it(
    'rejects ' +
      (malformed ? 'unparseable' : 'failed') +
      ' native OpenAI pages rather than returning unknown facts',
    async () => {
      globalThis.fetch = async (input) => {
        const url = String(input)
        if (url === OPENAI_MODELS_INDEX_URL)
          return new Response('[Model](/api/docs/models/gpt-5.md)')
        if (url === OPENAI_PRICING_URL) return new Response(pricing)
        if (url.endsWith('/gpt-5.md'))
          return malformed
            ? new Response('# Unexpected page')
            : new Response('outage', { status: 503 })
        throw new Error('unexpected source ' + url)
      }
      await expect(openaiModelFacts(['gpt-5'])).rejects.toThrow(
        malformed ? 'no Model ID' : '503',
      )
    },
  )

for (const reverse of [false, true])
  it(
    'prefers model-owned page facts over alias snapshot facts regardless of listing order ' +
      reverse,
    async () => {
      const own =
        'Model ID: `gpt-5.6-sol`\nReasoning.effort supports: low, high.\n\n## Model details\n\n- Reasoning token support\n'
      const alias =
        'Model ID: `gpt-daybreak-blue-latest`\n\n## Model details\n\n- Default snapshot: `gpt-5.6-sol`\n- Reasoning token support\n'
      globalThis.fetch = async (input) => {
        const url = String(input)
        if (url === OPENAI_MODELS_INDEX_URL)
          return new Response(
            '[Own](/api/docs/models/gpt-5.6-sol.md) [Alias](/api/docs/models/gpt-daybreak-blue-latest.md)',
          )
        if (url === OPENAI_PRICING_URL) return new Response(pricing)
        if (url.endsWith('/gpt-5.6-sol.md')) return new Response(own)
        if (url.endsWith('/gpt-daybreak-blue-latest.md'))
          return new Response(alias)
        throw new Error('unexpected source ' + url)
      }
      const ids = ['gpt-5.6-sol', 'gpt-daybreak-blue-latest']
      if (reverse) ids.reverse()
      const facts = await openaiModelFacts(ids)
      expect(facts('gpt-5.6-sol').reasoning?.efforts).toEqual(['low', 'high'])
      expect(facts('gpt-daybreak-blue-latest').reasoning).toBeNull()
      expect(facts('gpt-5.6-sol').factSources?.reasoning?.sourceUrl).toContain(
        '/gpt-5.6-sol.md',
      )
    },
  )
