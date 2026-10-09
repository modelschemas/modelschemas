import { expect, it } from 'vitest'
import {
  recordedSources,
  sourceHref,
  sourceLinkAlreadyShown,
} from './provenance.ts'

it('links only recorded absolute HTTP sources without embedded credentials', () => {
  expect(sourceHref('https://provider.example/docs?q=1')).toBe(
    'https://provider.example/docs?q=1',
  )
  for (const value of [
    null,
    '/docs',
    'javascript:alert(1)',
    'httpx://provider.example',
    'https://token@provider.example',
  ])
    expect(sourceHref(value)).toBeNull()
})
it('preserves leaf association, literal silence evidence and source fingerprints', () => {
  expect(
    recordedSources({
      capabilities: {
        reasoning: {
          derivation: 'docs-derived',
          sourceUrl: 'https://provider.example/reasoning',
          sourceHash: 'native-hash',
          path: 'exact native row',
        },
      },
      requestMapFields: {
        replayReasoningContent: {
          derivation: 'source-silent',
          sourceUrl: 'https://provider.example/history',
          checkedAt: '2026-10-09',
        },
      },
    }),
  ).toEqual([
    {
      field: 'capabilities.reasoning',
      trace: {},
      sourceUrl: 'https://provider.example/reasoning',
      sourceHash: 'native-hash',
      derivation: 'docs-derived',
      path: 'exact native row',
      checkedAt: null,
    },
    {
      field: 'requestMapFields.replayReasoningContent',
      trace: {},
      sourceUrl: 'https://provider.example/history',
      sourceHash: null,
      derivation: 'source-silent',
      path: null,
      checkedAt: '2026-10-09',
    },
  ])
})
it('does not fill missing sources, borrow a sibling URL, or expose unsafe URLs', () => {
  expect(recordedSources(null)).toEqual([])
  expect(
    recordedSources({
      contextWindow: { derivation: 'listing' },
      maxOutput: {
        derivation: 'docs-derived',
        sourceUrl: 'javascript:alert(1)',
      },
    }).map((x) => x.sourceUrl),
  ).toEqual([null, null])
})

it('does not hide a distinct recorded fact source behind a displayed pricing-card link', () => {
  expect(
    sourceLinkAlreadyShown(
      { sourceUrl: 'https://provider.example/prices' },
      'https://provider.example/prices',
    ),
  ).toBe(true)
  expect(
    sourceLinkAlreadyShown(
      { sourceUrl: 'https://provider.example/catalog' },
      'https://provider.example/prices',
    ),
  ).toBe(false)
  expect(
    sourceLinkAlreadyShown(
      { sourceUrl: null },
      'https://provider.example/prices',
    ),
  ).toBe(false)
  expect(
    sourceLinkAlreadyShown(
      { sourceUrl: 'javascript:alert(1)' },
      'javascript:alert(1)',
    ),
  ).toBe(false)
})

it('preserves literal existing acquisition and verification metadata in the trace', () => {
  const source = {
    sourceUrl: 'https://provider.example/spec',
    fetchedAt: 123,
    verifiedAt: null,
    endpointId: 'chat/completions',
    extractorVersion: 'native-v1',
  }
  expect(recordedSources({ schema: source })[0]!.trace).toEqual({
    fetchedAt: 123,
    verifiedAt: null,
    endpointId: 'chat/completions',
    extractorVersion: 'native-v1',
  })
})
