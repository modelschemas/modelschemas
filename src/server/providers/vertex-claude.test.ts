import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { price } from '@modelschemas/rate-card'
import {
  claudeCardModels,
  claudeCardPaths,
  claudeGlobalPrices,
} from './vertex-claude.ts'

const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/vertex-claude/${name}.html.txt`, import.meta.url),
    'utf8',
  )
const card = fixture('sonnet-4-6')
const prices = fixture('global-pricing')
const source = {
  url: 'https://cloud.google.com/pricing',
  hash: 'fixture-hash',
  extractedAt: '2026-10-09',
}

describe('Google native Claude sources', () => {
  it('reads exact hosted model identity and published facts without a body-schema guess', () => {
    const [row] = claudeCardModels(
      card,
      'https://docs.cloud.google.com/card',
      'hash',
    )
    expect(row).toMatchObject({
      rawId: 'claude-sonnet-4-6',
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      capabilities: ['tools', 'reasoning'],
      reasoning: null,
      requestMap: null,
      schemaEndpointId: null,
    })
    expect(row?.factSources?.maxOutput?.sourceHash).toBe('hash')
  })
  it('does not turn unreadable identity or token limits into a successful empty listing', () => {
    expect(() =>
      claudeCardModels(
        card.replaceAll('claude-sonnet-4-6', 'unknown'),
        source.url,
        'hash',
      ),
    ).toThrow('unreadable model id')
    expect(() =>
      claudeCardModels(
        card.replace(
          'Maximum output tokens: 128,000',
          'Maximum output tokens: unknown',
        ),
        source.url,
        'hash',
      ),
    ).toThrow('unreadable Maximum output tokens')
    expect(() => claudeCardPaths('<article>No models</article>')).toThrow(
      'no linked model cards',
    )
  })
  it('uses the explicitly Global rates with separately published prompt-length tiers', () => {
    const book = claudeGlobalPrices(prices, source)
    const sonnet = book.get('sonnet 4 6')
    expect(sonnet).toBeDefined()
    expect(
      price(sonnet!, {}, { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ).toBe(18)
    const haiku = book.get('haiku 5 5')
    expect(haiku).toBeDefined()
    expect(
      price(haiku!, {}, { input_tokens: 50_000, output_tokens: 1_000_000 }),
    ).toBeCloseTo(0.505)
    expect(
      price(haiku!, {}, { input_tokens: 200_000, output_tokens: 1_000_000 }),
    ).toBeCloseTo(2.6)
  })
  it('rejects malformed published prices and missing Global panels', () => {
    expect(() =>
      claudeGlobalPrices(prices.replace('$0.10', '$unknown'), source),
    ).toThrow('unreadable price')
    expect(() =>
      claudeGlobalPrices(prices.replace(/>Global</g, '>Regional<'), source),
    ).toThrow('no Global Claude price rows')
  })
  it('does not read a regional table after an empty Global panel', () => {
    const table = prices.match(/<table\b[\s\S]*?<\/table>/i)?.[0] ?? ''
    const emptyGlobal = prices.replace(table, '')
    expect(() =>
      claudeGlobalPrices(
        `${emptyGlobal}<div role="tabpanel" aria-labelledby="regional">${table}</div>`,
        source,
      ),
    ).toThrow('no Global Claude price rows')
  })
  it('leaves an incomplete published long tier unpriced instead of copying short rates', () => {
    // The native Global table leaves Opus 5.5's long input cell blank while
    // publishing other long-context prices. It supplies no complete card.
    expect(claudeGlobalPrices(prices, source).has('opus 5 5')).toBe(false)
  })
})
