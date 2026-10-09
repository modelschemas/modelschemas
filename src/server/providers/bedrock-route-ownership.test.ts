import { expect, it } from 'vitest'
import native from './fixtures/bedrock-native-thinking-guides.json'
import {
  bedrockReasoning,
  parseBedrockCard,
  parseBedrockProfileRows,
} from './bedrock-cards.ts'

const url =
  'https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.md'
const card = native[url]
const source = {
  url,
  hash: 'own-source-hash',
  extractedAt: '2026-10-09T00:00:00Z',
}
it('does not bind a mantle-only base ID to the runtime Converse schema or wire map', () => {
  const base = parseBedrockCard(card, source)
  expect(base?.rawId).toBe('anthropic.claude-haiku-4-5')
  expect(base?.requestMap).toBeNull()
  expect(base?.schemaEndpointId).toBeNull()
  expect(base?.aliases).toEqual([])
})
it('retains Converse only for the six runtime profile IDs explicitly declared by that native card', () => {
  const profiles = parseBedrockProfileRows(card, source)
  expect(profiles).toHaveLength(6)
  expect(profiles.map((profile) => profile.rawId)).toEqual([
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
    'au.anthropic.claude-haiku-4-5-20251001-v1:0',
    'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
    'in.anthropic.claude-haiku-4-5-20251001-v1:0',
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  ])
  for (const profile of profiles) {
    expect(profile.schemaEndpointId).toBe('model/{modelId}/converse')
    expect(profile.requestMap).toBeNull()
    expect(profile.factSources?.schemaEndpointId?.sourceUrl).toBe(url)
    expect(profile.factSources?.schemaEndpointId?.sourceHash).toBe(
      'own-source-hash',
    )
    expect(profile.aliases).toEqual([])
  }
})
it('a mantle profile cannot borrow the card-wide runtime Converse tick', () => {
  const altered = card.replace(
    /^(\| bedrock-mantle \|[^\n]+)N\/A \|[ \t]*$/m,
    '$1global.anthropic.claude-haiku-4-5-mantle |',
  )
  expect(altered).not.toBe(card)
  const profile = parseBedrockProfileRows(altered, source).find(
    (model) => model.rawId === 'global.anthropic.claude-haiku-4-5-mantle',
  )
  expect(profile).toBeDefined()
  expect(profile?.schemaEndpointId).toBeNull()
  expect(profile?.requestMap).toBeNull()
})
it('a native none label alone never proves disabling; explicit operational notes do', () => {
  expect(
    bedrockReasoning('Supported (configurable: none, low, medium, high)'),
  ).toEqual({
    mode: 'effort',
    mandatory: null,
    efforts: ['none', 'low', 'medium', 'high'],
  })
  expect(
    bedrockReasoning(
      'Supported (adaptive; effort level configurable — none, low, high)',
    )?.mandatory,
  ).toBeNull()
  expect(
    bedrockReasoning(
      'Supported (adaptive; can be disabled; effort level configurable — low, high)',
    )?.mandatory,
  ).toBe(false)
  expect(
    bedrockReasoning(
      'Supported (adaptive thinking cannot be disabled; effort level configurable — low, high)',
    )?.mandatory,
  ).toBe(true)
})
