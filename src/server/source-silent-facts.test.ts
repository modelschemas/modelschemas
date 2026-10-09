import { describe, expect, it } from 'vitest'
import {
  parseSourceSilentEvidence,
  withSourceSilentEvidence,
} from './source-silent-facts.ts'

const row = {
  providerId: 'synthetic',
  activity: 'chat',
  contextWindow: null,
  maxOutput: null,
  modalities: null,
  pricing: null,
  capabilities: null,
  reasoning: null,
  requestMap: null,
}
const ledger = parseSourceSilentEvidence(
  '- synthetic: maxOutput — absent, https://example.com/docs, checked 2026-10-09\n- synthetic: capabilities — absent, https://example.com/docs, checked 2026-10-09',
)

describe('source-silent API evidence', () => {
  it('copies recorded metadata and leaves absent metadata absent', () => {
    expect(ledger.get('synthetic')?.get('maxOutput')).toEqual({
      derivation: 'source-silent',
      sourceUrl: 'https://example.com/docs',
      checkedAt: '2026-10-09',
    })
    expect(
      parseSourceSilentEvidence('- synthetic: maxOutput — absent')
        .get('synthetic')
        ?.get('maxOutput'),
    ).toEqual({ derivation: 'source-silent' })
  })
  it('rejects typo facts and duplicate evidence instead of choosing an arbitrary source', () => {
    expect(() =>
      parseSourceSilentEvidence('- synthetic: maxOutputs — absent'),
    ).toThrow(/unknown fact/)
    expect(() =>
      parseSourceSilentEvidence(
        '- synthetic: maxOutput — absent\n- synthetic: maxOutput — absent',
      ),
    ).toThrow(/duplicate/)
  })
  it('rejects malformed recorded dates instead of dropping or normalizing them', () => {
    for (const date of ['2026-02-30', '2026-13-01', '2026-1-09', 'unknown']) {
      expect(() =>
        parseSourceSilentEvidence(
          `- synthetic: maxOutput — absent, checked ${date}`,
        ),
      ).toThrow(/invalid checked date/)
    }
  })
  it('adds evidence only for ledgered null facts, with whole-field capability silence', () => {
    const sources = withSourceSilentEvidence(row, null, null, ledger)
    expect(sources?.maxOutput?.derivation).toBe('source-silent')
    expect(sources?.capabilities).toEqual(
      ledger.get('synthetic')?.get('capabilities'),
    )
    expect(sources).not.toHaveProperty('contextWindow')
    expect(
      withSourceSilentEvidence(
        { ...row, providerId: 'unledgered' },
        null,
        null,
        ledger,
      ),
    ).toBeNull()
  })
  it('preserves populated facts and sameAs evidence without mutating stored sources', () => {
    const stored = {
      maxOutput: {
        derivation: 'listing' as const,
        sourceUrl: 'https://example.com/list',
      },
      capabilities: { tools: { derivation: 'listing' as const } },
      sameAs: { derivation: 'listing' as const, normalized: true as const },
      schemaEndpointId: {
        derivation: 'docs-derived' as const,
        sourceUrl: 'https://example.com/routes',
      },
    }
    expect(
      withSourceSilentEvidence(
        { ...row, maxOutput: 1024, capabilities: { tools: true } },
        null,
        stored,
        ledger,
      ),
    ).toEqual(stored)
    const missing = withSourceSilentEvidence(row, null, stored, ledger)
    expect(missing?.sameAs).toEqual(stored.sameAs)
    expect(missing?.schemaEndpointId).toEqual(stored.schemaEndpointId)
    expect(stored.maxOutput.derivation).toBe('listing')
  })
  it('keeps evidence for missing subfacts separate from populated parent provenance', () => {
    const subfacts = parseSourceSilentEvidence(
      '- synthetic: priced — absent\n- synthetic: cacheRead — absent\n- synthetic: efforts — absent\n- synthetic: endpoint — absent\n- synthetic: requestMap — absent',
    )
    const stored = {
      pricing: { derivation: 'listing' as const },
      reasoning: { derivation: 'listing' as const },
    }
    const model = {
      ...row,
      pricing: {
        tables: { rate: { base: { input_tokens: 1, output_tokens: 2 } } },
      },
      reasoning: { mode: 'effort', mandatory: null },
      requestMap: { replayReasoningContent: null },
    }
    const sources = withSourceSilentEvidence(model, null, stored, subfacts)
    expect(sources).toMatchObject({
      ...stored,
      cacheRead: { derivation: 'source-silent' },
      efforts: { derivation: 'source-silent' },
      schemaEndpointId: { derivation: 'source-silent' },
    })
    expect(sources).not.toHaveProperty('requestMap')
    expect(
      withSourceSilentEvidence(
        {
          ...model,
          pricing: { tables: { rate: { base: { cache_read_tokens: 0 } } } },
          reasoning: { mode: 'effort', efforts: ['low'] },
        },
        '/v1/chat',
        stored,
        subfacts,
      ),
    ).toEqual(stored)
  })
  it('does not apply chat ledger evidence to unrelated activities', () => {
    expect(
      withSourceSilentEvidence(
        { ...row, activity: 'image' },
        null,
        null,
        ledger,
      ),
    ).toBeNull()
  })
})
