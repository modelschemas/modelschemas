import { describe, expect, it } from 'vitest'

import { GPT_4O } from '../../packages/rate-card/src/fixtures/gpt-4o.ts'
import { NANO_BANANA_2 } from '../../packages/rate-card/src/fixtures/nano-banana-2.ts'
import {
  cardCurrency,
  compileOpenRouterPricing,
  compileTokenCard,
  compileUnitCard,
} from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { contentHash } from '#/server/kv.ts'
import { compileSeedanceCard } from '#/server/providers/byteplus-pricing.ts'
import { bytePlusArkSpec } from '#/server/providers/byteplus-spec.ts'
import {
  cardRequestParamsOk,
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

  it('re-reads a card whose source named a price change that has passed', async () => {
    const stored: RateCard = {
      ...GPT_4O,
      source: {
        ...GPT_4O.source,
        extractedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-06-01T00:00:00.000Z',
      },
    }
    const reparsed: RateCard = {
      ...GPT_4O,
      source: { ...GPT_4O.source, extractedAt: '2026-06-02T00:00:00.000Z' },
    }
    expect(
      await storeListedPricing(reparsed, {
        existing: stored,
        sourceUrl: SOURCE_URL,
        now: NOW,
      }),
    ).toEqual({ card: reparsed })
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
      currency: 'USD',
      per: 'token',
      inputPerMillion: 2.5,
      outputPerMillion: 10,
    })
  })

  it('says which currency the rates are in', () => {
    const card = compileTokenCard(
      { input_tokens: 20 / 1e6, output_tokens: 100 / 1e6 },
      [],
      GPT_4O.source,
      { currency: 'CNY' },
    )
    if (!card) throw new Error('did not compile')
    expect(projectTokenPricing(card)).toEqual({
      currency: 'CNY',
      per: 'token',
      inputPerMillion: 20,
      outputPerMillion: 100,
    })
    // The currency survives the stored-card parse, so it is never USD.
    const stored = parseStoredRateCard(JSON.parse(JSON.stringify(card)))
    expect(stored && cardCurrency(stored)).toBe('CNY')
  })

  // Per-token rates whose `× 1e6` is not the published figure in a double.
  it.each([
    [2e-7, 0.2],
    [1.45e-6, 1.45],
    [6.72e-7, 0.672],
    [1.7e-7, 0.17],
    [2.64e-7, 0.264],
    [2.76e-7, 0.276],
    [3e-8, 0.03],
    [1.5e-5, 15],
  ])('serves %d per token as %d per million, no float noise', (rate, per) => {
    const card = compileTokenCard(
      { input_tokens: rate, output_tokens: rate },
      [],
      GPT_4O.source,
    )
    if (!card) throw new Error('did not compile')
    expect(projectTokenPricing(card)).toEqual({
      currency: 'USD',
      per: 'token',
      inputPerMillion: per,
      outputPerMillion: per,
    })
  })

  it('names the unit a media card bills by', () => {
    expect(projectTokenPricing(NANO_BANANA_2)).toEqual({
      currency: 'USD',
      per: 'image',
    })
    const perSecond = compileUnitCard(
      { quantity: { param: 'audio_seconds', bound: 'usage' }, rates: 1e-4 },
      GPT_4O.source,
    )
    if (!perSecond) throw new Error('did not compile')
    expect(projectTokenPricing(perSecond)).toEqual({
      currency: 'USD',
      per: 'second',
    })
    const flat = compileUnitCard({ rates: 0.08 }, GPT_4O.source)
    if (!flat) throw new Error('did not compile')
    expect(projectTokenPricing(flat)).toEqual({
      currency: 'USD',
      per: 'request',
    })
  })

  it('shows the base rate of a tiered card and says so', () => {
    const card = compileTokenCard(
      { input_tokens: 10e-6, output_tokens: 50e-6 },
      [
        {
          minPromptTokens: 272_000,
          rates: { input_tokens: 20e-6, output_tokens: 75e-6 },
        },
      ],
      GPT_4O.source,
    )
    if (!card) throw new Error('did not compile')
    expect(projectTokenPricing(card)).toEqual({
      currency: 'USD',
      per: 'token',
      inputPerMillion: 10,
      outputPerMillion: 50,
      tiered: true,
    })
  })

  it('projects an embeddings card without an output rate', () => {
    const card = compileTokenCard({ input_tokens: 0.02e-6 }, [], GPT_4O.source)
    if (!card) throw new Error('did not compile')
    expect(projectTokenPricing(card)).toEqual({
      currency: 'USD',
      per: 'token',
      inputPerMillion: 0.02,
    })
  })

  it('drops the rates when a per-request fee breaks linearity', () => {
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
    expect(projectTokenPricing(card)).toEqual({
      currency: 'USD',
      per: 'token',
    })
    expect(servePricing(card, 'full')).toEqual(card)
  })
})

describe('servePricing', () => {
  it('serves a compact projection on list and the full card on detail', () => {
    expect(servePricing(GPT_4O, 'compact')).toEqual({
      currency: 'USD',
      per: 'token',
      inputPerMillion: 2.5,
      outputPerMillion: 10,
    })
    expect(servePricing(GPT_4O, 'full')).toEqual(GPT_4O)
    expect(servePricing(NANO_BANANA_2, 'compact')).toEqual({
      currency: 'USD',
      per: 'image',
    })
    expect(servePricing(NANO_BANANA_2, 'full')).toEqual(NANO_BANANA_2)
  })

  it('does not serve leftover vendor blobs', () => {
    expect(servePricing(GPT_4O_LISTING, 'full')).toBeNull()
    expect(servePricing({ prompt: '0', completion: '0' }, 'compact')).toBeNull()
  })
})

/** A Seedance-shaped card whose completion_tokens estimate reads `guideHash`. */
function estimatedCard(guideHash: string, param = 'duration'): RateCard {
  const card = compileSeedanceCard(
    { default: { '*': { all: 2.5 } } },
    GPT_4O.source,
    {
      model: { fps: 24, dims: { '720p': { '16:9': { w: 1280, h: 720 } } } },
      url: 'https://example.com/guide',
      hash: guideHash,
    },
  )
  if (!card) throw new Error('no card')
  const tokens = card.inputs.completion_tokens
  if (tokens?.kind === 'number' && tokens.estimate && param !== 'duration') {
    tokens.estimate.inputs.duration = { param, kind: 'number' }
  }
  return card
}

describe('estimate sources', () => {
  it('replaces a stored card when only the estimate source changed', async () => {
    const stored = estimatedCard('b'.repeat(64))
    const fresh = estimatedCard('c'.repeat(64))
    expect(
      await storeListedPricing(fresh, {
        existing: stored,
        sourceUrl: SOURCE_URL,
        now: NOW,
      }),
    ).toEqual({ card: fresh })
    expect(
      await storeListedPricing(estimatedCard('b'.repeat(64)), {
        existing: stored,
        sourceUrl: SOURCE_URL,
        now: NOW,
      }),
    ).toEqual({ card: stored })
  })

  it("checks an estimate's request levers against the bound schema", () => {
    const spec = bytePlusArkSpec() as {
      components: { schemas: Record<string, { properties?: object }> }
    }
    const task = new Set(
      Object.keys(
        spec.components.schemas.VideoTaskCreateRequest?.properties ?? {},
      ),
    )
    expect(cardRequestParamsOk(estimatedCard('b'.repeat(64)), task)).toBe(true)
    expect(
      cardRequestParamsOk(estimatedCard('b'.repeat(64), 'seconds'), task),
    ).toBe(false)
  })
})
