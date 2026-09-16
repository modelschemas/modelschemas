import { describe, expect, it } from 'vitest'

import { GPT_4O } from '../../packages/rate-card/src/fixtures/gpt-4o.ts'
import { NANO_BANANA_2 } from '../../packages/rate-card/src/fixtures/nano-banana-2.ts'
import { compileOpenRouterPricing } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { contentHash } from '#/server/kv.ts'
import {
  parseStoredRateCard,
  projectTokenPricing,
  servePricing,
  storeListedPricing,
  toStoredRateCard,
} from '#/server/rate-card.ts'

const SOURCE_URL = 'https://openrouter.ai/api/v1/models'
const NOW = 1_781_150_000

const GPT_4O_LISTING = {
  prompt: '0.0000025',
  completion: '0.00001',
  input_cache_read: '0.00000125',
}

function mediaCard(param: string): RateCard {
  return {
    inputs: {
      duration: { param, kind: 'number', default: 5 },
    },
    tables: {},
    price: { '*': [{ var: 'duration' }, 0.1] },
    examples: [],
    source: GPT_4O.source,
  }
}

describe('parseStoredRateCard', () => {
  it('accepts a RateCard and rejects vendor blobs', () => {
    expect(parseStoredRateCard(GPT_4O)).toEqual(GPT_4O)
    expect(parseStoredRateCard(GPT_4O_LISTING)).toBeNull()
    expect(parseStoredRateCard({ prompt: '0', completion: '0' })).toBeNull()
    expect(
      parseStoredRateCard({ amount_per_sec: 17, unit: 'credits' }),
    ).toBeNull()
    expect(parseStoredRateCard(null)).toBeNull()
  })
})

describe('toStoredRateCard', () => {
  it('stores a RateCard that parses and whose examples verify', async () => {
    expect(
      await toStoredRateCard(GPT_4O, { sourceUrl: SOURCE_URL, now: NOW }),
    ).toEqual(GPT_4O)
  })

  it('compiles an OpenRouter listing into a usage-bound token card', async () => {
    const card = await toStoredRateCard(GPT_4O_LISTING, {
      sourceUrl: SOURCE_URL,
      now: NOW,
    })
    expect(card).not.toBeNull()
    expect(card?.inputs.input_tokens?.bound).toBe('usage')
    expect(card?.inputs.output_tokens?.bound).toBe('usage')
    expect(card?.source.url).toBe(SOURCE_URL)
    expect(card?.source.hash).toBe(await contentHash(GPT_4O_LISTING))
    expect(card?.source.extractedAt).toBe(new Date(NOW * 1000).toISOString())
  })

  it('reuses an existing compiled card when the listing hash matches', async () => {
    const first = await toStoredRateCard(GPT_4O_LISTING, {
      sourceUrl: SOURCE_URL,
      now: NOW,
    })
    const later = await toStoredRateCard(GPT_4O_LISTING, {
      existing: first,
      sourceUrl: SOURCE_URL,
      now: NOW + 900,
    })
    expect(later).toEqual(first)
    expect(later?.source.extractedAt).toBe(first?.source.extractedAt)
  })

  it('turns Together-style all-zero listings into null', async () => {
    expect(
      await toStoredRateCard(
        { prompt: '0', completion: '0' },
        { sourceUrl: SOURCE_URL, now: NOW },
      ),
    ).toBeNull()
  })

  it('refuses unknown blobs rather than storing them', async () => {
    expect(
      await toStoredRateCard(
        { amount_per_sec: 17, unit: 'credits' },
        { sourceUrl: SOURCE_URL, now: NOW },
      ),
    ).toBeNull()
  })

  it('refuses a request-bound param that is not on the bound schema', async () => {
    const card = mediaCard('quality')
    expect(
      await toStoredRateCard(card, {
        sourceUrl: SOURCE_URL,
        now: NOW,
        requestProperties: new Set(['model', 'messages']),
      }),
    ).toBeNull()
  })

  it('allows a request-bound param that is a schema property', async () => {
    const card = mediaCard('duration')
    expect(
      await toStoredRateCard(card, {
        sourceUrl: SOURCE_URL,
        now: NOW,
        requestProperties: new Set(['duration', 'generate_audio']),
      }),
    ).toEqual(card)
  })

  it('allows documented card-level levers such as input_tokens', async () => {
    const card: RateCard = {
      ...GPT_4O,
      inputs: {
        ...GPT_4O.inputs,
        input_tokens: {
          param: 'input_tokens',
          bound: 'request',
          kind: 'number',
        },
      },
    }
    expect(
      await toStoredRateCard(card, {
        sourceUrl: SOURCE_URL,
        now: NOW,
        requestProperties: new Set(['model', 'messages']),
      }),
    ).toEqual(card)
  })

  it('skips the schema check when the model has no bound input schema', async () => {
    const card = mediaCard('quality')
    expect(
      await toStoredRateCard(card, { sourceUrl: SOURCE_URL, now: NOW }),
    ).toEqual(card)
  })

  it('recompiles when the listing rates change', async () => {
    const first = await toStoredRateCard(GPT_4O_LISTING, {
      sourceUrl: SOURCE_URL,
      now: NOW,
    })
    const raised = { prompt: '0.000005', completion: '0.00002' }
    const later = await toStoredRateCard(raised, {
      existing: first,
      sourceUrl: SOURCE_URL,
      now: NOW + 900,
    })
    expect(later?.source.hash).toBe(await contentHash(raised))
    expect(later?.source.hash).not.toBe(first?.source.hash)
    expect(later?.source.extractedAt).toBe(
      new Date((NOW + 900) * 1000).toISOString(),
    )
  })

  it('refuses a schema-valid card whose examples do not verify', async () => {
    const first = GPT_4O.examples[0]
    if (!first) throw new Error('fixture missing examples')
    const bad: RateCard = {
      ...GPT_4O,
      examples: [{ ...first, usd: 999 }],
    }
    expect(
      await storeListedPricing(bad, { sourceUrl: SOURCE_URL, now: NOW }),
    ).toEqual({ card: null, refused: 'examples' })
  })

  it('keeps the stored card when a re-parse reports the same source hash', async () => {
    const stored: RateCard = {
      ...GPT_4O,
      source: { ...GPT_4O.source, extractedAt: '2026-01-01T00:00:00.000Z' },
    }
    const reparsed: RateCard = {
      ...GPT_4O,
      source: { ...GPT_4O.source, extractedAt: '2026-06-01T00:00:00.000Z' },
    }
    expect(
      await storeListedPricing(reparsed, {
        existing: stored,
        sourceUrl: SOURCE_URL,
        now: NOW,
      }),
    ).toEqual({ card: stored })
  })

  it('names invented_param vs uncompilable on refuse', async () => {
    expect(
      await storeListedPricing(mediaCard('quality'), {
        sourceUrl: SOURCE_URL,
        now: NOW,
        requestProperties: new Set(['model']),
      }),
    ).toEqual({ card: null, refused: 'invented_param' })
    expect(
      await storeListedPricing(
        { prompt: '0', completion: '0' },
        { sourceUrl: SOURCE_URL, now: NOW },
      ),
    ).toEqual({ card: null, refused: 'uncompilable' })
  })
})

describe('projectTokenPricing', () => {
  it('projects a simple token formula to per-million rates', () => {
    expect(projectTokenPricing(GPT_4O)).toEqual({
      inputPerMillion: 2.5,
      outputPerMillion: 10,
    })
  })

  it('omits the projection for media cards', () => {
    expect(projectTokenPricing(NANO_BANANA_2)).toBeNull()
  })

  it('omits the projection when a per-request fee breaks linearity', () => {
    const card = compileOpenRouterPricing(
      {
        prompt: '0.0000025',
        completion: '0.00001',
        request: '0.01',
      },
      GPT_4O.source,
    )
    expect(card).not.toBeNull()
    if (!card) return
    expect(projectTokenPricing(card)).toBeNull()
    expect(servePricing(card, 'full')).toEqual(card)
  })
})

describe('servePricing', () => {
  it('serves a compact projection on list and the full card on detail', () => {
    expect(servePricing(GPT_4O, 'compact')).toEqual({
      inputPerMillion: 2.5,
      outputPerMillion: 10,
    })
    expect(servePricing(GPT_4O, 'full')).toEqual(GPT_4O)
    expect(servePricing(NANO_BANANA_2, 'compact')).toBeNull()
    expect(servePricing(NANO_BANANA_2, 'full')).toEqual(NANO_BANANA_2)
  })

  it('does not serve leftover vendor blobs', () => {
    expect(servePricing(GPT_4O_LISTING, 'full')).toBeNull()
    expect(servePricing({ prompt: '0', completion: '0' }, 'compact')).toBeNull()
  })
})
