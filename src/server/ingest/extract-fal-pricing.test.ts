import { describe, expect, it, vi } from 'vitest'

import { verifyExamples } from '@modelschemas/rate-card'

import { NANO_BANANA_2 } from '../../../packages/rate-card/src/fixtures/nano-banana-2.ts'

import {
  FAL_PRICING_EXTRACT_CRONS,
  FAL_PRICING_EXTRACT_CAP,
  FAL_PRICING_EXTRACT_MODEL,
  FAL_PRICING_FETCH_CAP,
  FAL_PRICING_FETCH_FAIL_ABORT,
  checkExtractedCard,
  isRetryableLlmsStatus,
  extractRateCardWithGrok,
  isStubPricingSection,
  pricingSection,
  pricingSectionHash,
  resumeIndex,
  shouldSkipExtract,
} from './extract-fal-pricing.ts'
import { parseFalUnitRate } from './fal-unit-rate.ts'
import { SPEC_SYNC_SHARD_CRONS } from './sync.ts'

/** A fetch mock answering successive chat calls with these contents. */
function grokReplies(...replies: Array<unknown>) {
  const mock = vi.fn<typeof fetch>()
  for (const reply of replies) {
    const content = typeof reply === 'string' ? reply : JSON.stringify(reply)
    mock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
      }),
    )
  }
  return mock
}

const NANO_LLMS = `# Nano Banana 2

## Overview

- **Endpoint**: \`https://fal.run/fal-ai/nano-banana-2\`

## Pricing

Your request will cost **$0.08** per image. For **$1.00**, you can run this model **12** times. 2K and 4K outputs will be charged at **1.5** times and **2** times the standard rate, respectively. 0.5K (512px) resolution outputs will be charged at **0.75** times the standard rate. If web search is used, an additional $0.015 will be charged. If high thinking is used, an additional $0.002 will be charged. **Note: Pricing is subject to change.**

For more details, see [fal.ai pricing](https://fal.ai/pricing).

## API Information

This model can be used via our HTTP API.
`

describe('pricingSection', () => {
  it('cuts the Pricing heading from llms.txt and ignores sibling sections', () => {
    const section = pricingSection(NANO_LLMS)
    expect(section.startsWith('## Pricing')).toBe(true)
    expect(section).toContain('$0.08')
    expect(section).not.toContain('API Information')
    expect(section).not.toContain('Nano Banana 2 is')
  })

  it('is empty when the heading is absent', () => {
    expect(pricingSection('# Title\n\n## Overview\n\nNope.\n')).toBe('')
  })
})

describe('isStubPricingSection', () => {
  it('treats empty, boilerplate, and zero-dollar sections as stubs', () => {
    expect(isStubPricingSection('')).toBe(true)
    expect(
      isStubPricingSection(
        '## Pricing\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
      ),
    ).toBe(true)
    expect(
      isStubPricingSection(
        '## Pricing\n\nYour request will cost **$0.00** per image.',
      ),
    ).toBe(true)
  })

  it('keeps a section that names a positive price', () => {
    expect(isStubPricingSection(pricingSection(NANO_LLMS))).toBe(false)
  })

  it('keeps bold and suffix-$ prices the old regex missed (#70)', () => {
    expect(isStubPricingSection('- **Price**: $**0.04** per images')).toBe(
      false,
    )
    expect(isStubPricingSection('- **Price**: **0.17** $ per second')).toBe(
      false,
    )
  })
})

describe('pricingSectionHash', () => {
  it('hashes the Pricing section, not the rest of the file', async () => {
    const a = await pricingSectionHash(pricingSection(NANO_LLMS))
    const b = await pricingSectionHash(
      pricingSection(NANO_LLMS.replace('Nano Banana 2', 'Renamed')),
    )
    const c = await pricingSectionHash(
      pricingSection(NANO_LLMS.replace('$0.08', '$0.09')),
    )
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })
})

describe('resumeIndex', () => {
  const ids = ['a/one', 'b/two', 'c/three']

  it('starts at 0 with no cursor and wraps past the tail', () => {
    expect(resumeIndex(ids, null)).toBe(0)
    expect(resumeIndex(ids, 'c/three')).toBe(0)
    expect(resumeIndex(ids, 'b/two')).toBe(2)
  })

  it('resumes after a cursor that left the roster', () => {
    expect(resumeIndex(ids, 'a/two')).toBe(1)
    expect(resumeIndex(ids, 'z/gone')).toBe(0)
  })
})

describe('shouldSkipExtract', () => {
  const hash = 'a'.repeat(64)
  const now = 1_781_150_000

  it('skips an unchanged hash and re-extracts after expiresAt', () => {
    expect(
      shouldSkipExtract({
        storedHash: hash,
        sectionHash: hash,
        hasCard: true,
        stub: false,
        expiresAt: undefined,
        now,
      }),
    ).toBe(true)
    expect(
      shouldSkipExtract({
        storedHash: hash,
        sectionHash: 'b'.repeat(64),
        hasCard: true,
        stub: false,
        expiresAt: undefined,
        now,
      }),
    ).toBe(false)
    expect(
      shouldSkipExtract({
        storedHash: hash,
        sectionHash: hash,
        hasCard: true,
        stub: false,
        expiresAt: '2020-01-01T00:00:00.000Z',
        now,
      }),
    ).toBe(false)
    expect(
      shouldSkipExtract({
        storedHash: hash,
        sectionHash: hash,
        hasCard: true,
        stub: false,
        expiresAt: '2099-01-01T00:00:00.000Z',
        now,
      }),
    ).toBe(true)
  })

  it('retries an unchanged hash whose card is still null unless it is a stub (#84)', () => {
    const base = { storedHash: hash, sectionHash: hash, expiresAt: undefined }
    expect(
      shouldSkipExtract({ ...base, hasCard: false, stub: false, now }),
    ).toBe(false)
    expect(
      shouldSkipExtract({ ...base, hasCard: false, stub: true, now }),
    ).toBe(true)
  })
})

describe('FAL_PRICING_EXTRACT_CRONS', () => {
  it('is six hourly daytime shards, none of them a spec-sync shard', () => {
    expect([...FAL_PRICING_EXTRACT_CRONS]).toEqual([
      '0 6 * * *',
      '0 7 * * *',
      '0 8 * * *',
      '0 9 * * *',
      '0 10 * * *',
      '0 11 * * *',
    ])
    expect(FAL_PRICING_FETCH_CAP).toBe(250)
    expect(FAL_PRICING_EXTRACT_CAP).toBe(40)
    expect(FAL_PRICING_FETCH_FAIL_ABORT).toBe(8)
    expect(FAL_PRICING_EXTRACT_MODEL).toBe('grok-4-fast')
    for (const cron of FAL_PRICING_EXTRACT_CRONS) {
      expect(
        (SPEC_SYNC_SHARD_CRONS as ReadonlyArray<string>).includes(cron),
      ).toBe(false)
      expect(cron).not.toBe('*/15 * * * *')
    }
    // Six shards x 250 fetches covers the FAL roster in one calendar day.
    expect(
      FAL_PRICING_EXTRACT_CRONS.length * FAL_PRICING_FETCH_CAP,
    ).toBeGreaterThanOrEqual(1500)
  })

  it('keeps wrangler.jsonc in lockstep', async () => {
    const fs = await import('node:fs/promises')
    const raw = await fs.readFile('wrangler.jsonc', 'utf8')
    for (const cron of FAL_PRICING_EXTRACT_CRONS) {
      expect(raw).toContain(`"${cron}"`)
    }
    expect(raw).toContain('"*/15 * * * *"')
    for (const cron of SPEC_SYNC_SHARD_CRONS) {
      expect(raw).toContain(`"${cron}"`)
    }
  })
})

describe('isRetryableLlmsStatus', () => {
  it('retries network, 408, 429, and 5xx; 404 is done', () => {
    expect(isRetryableLlmsStatus(0)).toBe(true)
    expect(isRetryableLlmsStatus(408)).toBe(true)
    expect(isRetryableLlmsStatus(429)).toBe(true)
    expect(isRetryableLlmsStatus(500)).toBe(true)
    expect(isRetryableLlmsStatus(503)).toBe(true)
    expect(isRetryableLlmsStatus(404)).toBe(false)
    expect(isRetryableLlmsStatus(400)).toBe(false)
  })
})

describe('extractRateCardWithGrok', () => {
  const args = {
    pricingText: pricingSection(NANO_LLMS),
    requestProperties: new Set([
      'num_images',
      'resolution',
      'enable_web_search',
      'thinking_level',
    ]),
    sourceUrl: NANO_BANANA_2.source.url,
    sourceHash: 'c'.repeat(64),
    now: 1_781_150_000,
    apiKey: 'xai-test',
  }

  it('stamps source and accepts a verified card', async () => {
    const { source: _source, ...body } = NANO_BANANA_2
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(body) } }],
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const card = await extractRateCardWithGrok(args)
      expect(card).not.toBeNull()
      expect(card).not.toBe('unverified')
      if (card === null || card === 'unverified') return
      expect(card.source.hash).toBe(args.sourceHash)
      expect(card.source.url).toBe(args.sourceUrl)
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://api.x.ai/v1/chat/completions',
      )
      const init = fetchMock.mock.calls[0]?.[1]
      expect(init?.method).toBe('POST')
      const payload = JSON.parse(String(init?.body)) as {
        model: string
      }
      expect(payload.model).toBe(FAL_PRICING_EXTRACT_MODEL)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns unverified only for a section that names no price', async () => {
    const fetchMock = grokReplies({ unverified: true })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(
        extractRateCardWithGrok({
          ...args,
          pricingText:
            '## Pricing\n\nSee [fal.ai pricing](https://fal.ai/pricing).',
        }),
      ).resolves.toBe('unverified')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('sends a priced section back once when the model says unverified (#88)', async () => {
    const { source: _source, ...body } = NANO_BANANA_2
    const fetchMock = grokReplies({ unverified: true }, body)
    vi.stubGlobal('fetch', fetchMock)
    try {
      const card = await extractRateCardWithGrok(args)
      expect(card).toMatchObject({ price: NANO_BANANA_2.price })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const retry = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
        model: string
        messages: Array<{ role: string; content: string }>
      }
      expect(retry.model).toBe(FAL_PRICING_EXTRACT_MODEL)
      expect(retry.messages.map((m) => m.role)).toEqual([
        'system',
        'user',
        'assistant',
        'user',
      ])
      expect(retry.messages[3]?.content).toContain('$0.08')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns null when a priced section is refused twice', async () => {
    const { source: _source, ...body } = NANO_BANANA_2
    for (const reply of [{ unverified: true }, { ...body, examples: [] }]) {
      const fetchMock = grokReplies(reply, reply)
      vi.stubGlobal('fetch', fetchMock)
      try {
        await expect(extractRateCardWithGrok(args)).resolves.toBeNull()
        expect(fetchMock).toHaveBeenCalledTimes(2)
      } finally {
        vi.unstubAllGlobals()
      }
    }
  })

  it('returns null when verifyExamples fails on both turns', async () => {
    const { source: _source, examples, ...body } = NANO_BANANA_2
    const first = examples[0]
    const bad = {
      ...body,
      examples: first
        ? [{ ...first, usd: 999 }]
        : [{ params: {}, usd: 999, quote: 'nope' }],
    }
    const fetchMock = grokReplies(bad, bad)
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(extractRateCardWithGrok(args)).resolves.toBeNull()
      const retry = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
        messages: Array<{ content: string }>
      }
      expect(retry.messages[3]?.content).toContain('verifyExamples failed')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a request-bound param the input schema does not have', async () => {
    const { source: _source, ...body } = NANO_BANANA_2
    const invented = {
      ...body,
      inputs: {
        ...body.inputs,
        num_images: { param: 'image_count', kind: 'number', default: 1 },
      },
    }
    vi.stubGlobal('fetch', grokReplies(invented, invented))
    try {
      await expect(extractRateCardWithGrok(args)).resolves.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails closed on a non-card payload', async () => {
    vi.stubGlobal('fetch', grokReplies({ nope: true }, 'not json'))
    try {
      await expect(extractRateCardWithGrok(args)).resolves.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('checkExtractedCard', () => {
  const base = {
    requestProperties: new Set(['resolution', 'duration']),
    sourceUrl:
      'https://fal.ai/models/fal-ai/wan-25-preview/text-to-video/llms.txt',
    sourceHash: 'd'.repeat(64),
    now: 1_781_150_000,
  }

  /** Live fal-ai/wan-25-preview/text-to-video, read 2026-09-30. */
  const WAN_TABLE = `## Pricing

Your request will cost **$0.05** per second for **480p**, **$0.10** per second for **720p**, **$0.15** per second for **1080p**.

For more details, see [fal.ai pricing](https://fal.ai/pricing).`

  it('accepts a lookup calculator for a per-second resolution table', () => {
    // The fast path refuses several rates by design — this is leftover work.
    expect(parseFalUnitRate(WAN_TABLE)).toBeNull()
    const reply = {
      inputs: {
        resolution: {
          param: 'resolution',
          kind: 'enum',
          bound: 'request',
          values: ['480p', '720p', '1080p'],
          default: '1080p',
        },
        seconds: { param: 'seconds', kind: 'number', bound: 'usage' },
      },
      tables: { rate: { '480p': 0.05, '720p': 0.1, '1080p': 0.15 } },
      price: {
        '*': [
          { var: 'seconds' },
          { lookup: { table: 'rate', keys: [{ var: 'resolution' }] } },
        ],
      },
      examples: [
        {
          params: { resolution: '480p', seconds: 1 },
          usd: 0.05,
          quote: 'Your request will cost **$0.05** per second for **480p**',
        },
        {
          params: { resolution: '720p', seconds: 1 },
          usd: 0.1,
          quote: '**$0.10** per second for **720p**',
        },
        {
          params: { seconds: 1 },
          usd: 0.15,
          quote: '**$0.15** per second for **1080p**',
        },
      ],
    }
    const card = checkExtractedCard(JSON.stringify(reply), {
      ...base,
      pricingText: WAN_TABLE,
    })
    if (card === 'unverified' || 'error' in card) {
      throw new Error(JSON.stringify(card))
    }
    expect(card.source.hash).toBe(base.sourceHash)
    expect(verifyExamples(card).every((r) => r.ok)).toBe(true)
    expect(card.price).toMatchObject({
      '*': [{ var: 'seconds' }, { lookup: {} }],
    })
  })

  it('refuses unverified for the table but allows it for a zero-price stub', () => {
    const refused = checkExtractedCard('{"unverified":true}', {
      ...base,
      pricingText: WAN_TABLE,
    })
    expect(
      typeof refused === 'object' && 'error' in refused && refused.error,
    ).toContain('$0.05')
    expect(
      checkExtractedCard('{"unverified":true}', {
        ...base,
        pricingText:
          '## Pricing\n\nYour request will cost **$0.00** per image.',
      }),
    ).toBe('unverified')
  })
})
