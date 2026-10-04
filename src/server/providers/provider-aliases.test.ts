import { describe, expect, it } from 'vitest'

import {
  applyDocumentedAliases,
  candidatesStillListed,
  claudeModelPageUrls,
  parseClaudeAliases,
  parseModelAliasPage,
  resolveAlias,
  UNDOCUMENTED_CANDIDATE_IDS,
} from './provider-aliases.ts'
import type { ModelInfo } from './types.ts'

const OVERVIEW = `
| Feature | Claude Haiku 4.5 | Claude Opus 4.8 |
| --- | --- | --- |
| Claude API ID | \`claude-haiku-4-5-20251001\` | \`claude-opus-4-8\` |
| Claude API alias | \`claude-haiku-4-5\` | \`claude-opus-4-8\` |
`

const OPUS_PAGE = `
| Platform | Model ID |
| --- | --- |
| Claude API | \`claude-opus-4-5-20251101\` |
| Claude API alias | \`claude-opus-4-5\` |
| [Status](https://example.com) | Active (legacy) |
`

const SONNET_PAGE = `
| Platform | Model ID |
| --- | --- |
| Claude API | \`claude-sonnet-4-5-20250929\` |
| Claude API alias | \`claude-sonnet-4-5\` |
| Status | Deprecated |
`

const RETIRED_PAGE = `
| Platform | Model ID |
| --- | --- |
| Claude API | \`claude-opus-4-1-20250805\` |
| Claude API alias | \`claude-opus-4-1\` |
| Status | Retired |
`

const DEPRECATIONS = `
## Model status

| API model name | Current state |
| --- | --- |
| claude-opus-4-5-20251101 | Active |
| claude-opus-4-1-20250805 | Retired |
| claude-sonnet-4-5-20250929 | Deprecated |
| claude-haiku-4-5-20251001 | Active |
`

const CARD = { inputs: {}, tables: {}, price: true, examples: [], source: {} }
const REASONING = { mode: 'budget' as const, mandatory: false }

function listed(): Array<ModelInfo> {
  return [
    {
      rawId: 'claude-opus-4-5-20251101',
      pricing: CARD,
      reasoning: REASONING,
    },
    {
      rawId: 'claude-sonnet-4-5-20250929',
      pricing: CARD,
      reasoning: REASONING,
    },
    {
      rawId: 'claude-haiku-4-5-20251001',
      pricing: CARD,
      reasoning: REASONING,
    },
    { rawId: 'claude-opus-4-8', pricing: null, reasoning: null },
  ]
}

describe('provider aliases', () => {
  it('resolves a documented alias to the dated row and its card', () => {
    const aliases = parseClaudeAliases([OVERVIEW, OPUS_PAGE, SONNET_PAGE])
    const models = applyDocumentedAliases(listed(), aliases)
    const resolved = resolveAlias('claude-opus-4-5', models)
    const dated = models.find(
      (model) => model.rawId === 'claude-opus-4-5-20251101',
    )
    expect(resolved?.rawId).toBe('claude-opus-4-5-20251101')
    expect(resolved?.pricing).toBe(dated?.pricing)
    expect(resolved?.reasoning).toBe(dated?.reasoning)
    expect(resolveAlias('claude-sonnet-4-5', models)?.rawId).toBe(
      'claude-sonnet-4-5-20250929',
    )
    expect(resolveAlias('claude-haiku-4-5', models)?.rawId).toBe(
      'claude-haiku-4-5-20251001',
    )
    expect(dated?.aliases).toEqual(['claude-opus-4-5'])
  })

  it('does not resolve a retired id or an unlisted candidate', () => {
    expect(parseModelAliasPage(RETIRED_PAGE)).toBeNull()
    const aliases = parseClaudeAliases([
      OVERVIEW,
      OPUS_PAGE,
      SONNET_PAGE,
      RETIRED_PAGE,
    ])
    expect(aliases.has('claude-opus-4-1')).toBe(false)
    const models = applyDocumentedAliases(listed(), aliases)
    expect(resolveAlias('claude-opus-4-1', models)).toBeNull()
    expect(resolveAlias('claude-opus-4-1-20250805', models)).toBeNull()
    // The dated id is not in this listing, so the alias is not attached.
    const withoutOpus = applyDocumentedAliases(
      listed().filter((model) => model.rawId !== 'claude-opus-4-5-20251101'),
      aliases,
    )
    expect(resolveAlias('claude-opus-4-5', withoutOpus)).toBeNull()
    expect(
      candidatesStillListed(
        UNDOCUMENTED_CANDIDATE_IDS,
        new Set(['gpt-5.3-codex']),
      ),
    ).toEqual([])
    expect(
      candidatesStillListed(
        ['llama-3.3-70b-versatile'],
        new Set(['llama-3.3-70b-versatile']),
      ),
    ).toEqual(['llama-3.3-70b-versatile'])
  })

  it('skips retired deprecation rows when collecting model pages', () => {
    const urls = claudeModelPageUrls(
      'See [Opus 4.5](https://platform.claude.com/docs/en/models/opus-4-5/overview).',
      DEPRECATIONS,
    )
    expect(urls).toContain(
      'https://platform.claude.com/docs/en/models/opus-4-5/overview.md',
    )
    expect(urls).toContain(
      'https://platform.claude.com/docs/en/models/sonnet-4-5/overview.md',
    )
    expect(urls).toContain(
      'https://platform.claude.com/docs/en/models/haiku-4-5/overview.md',
    )
    expect(urls.some((url) => url.includes('opus-4-1'))).toBe(false)
  })
})
