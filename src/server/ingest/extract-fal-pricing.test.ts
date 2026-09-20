import { describe, expect, it, vi } from 'vitest'

import { NANO_BANANA_2 } from '../../../packages/rate-card/src/fixtures/nano-banana-2.ts'

import {
  FAL_PRICING_EXTRACT_CRON,
  FAL_PRICING_EXTRACT_CAP,
  FAL_PRICING_EXTRACT_MODEL,
  FAL_PRICING_FETCH_CAP,
  extractRateCardWithGrok,
  isStubPricingSection,
  pricingSection,
  pricingSectionHash,
  resumeIndex,
  shouldSkipExtract,
} from './extract-fal-pricing.ts'
import { SPEC_SYNC_SHARD_CRONS } from './sync.ts'

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
        expiresAt: undefined,
        now,
      }),
    ).toBe(true)
    expect(
      shouldSkipExtract({
        storedHash: hash,
        sectionHash: 'b'.repeat(64),
        expiresAt: undefined,
        now,
      }),
    ).toBe(false)
    expect(
      shouldSkipExtract({
        storedHash: hash,
        sectionHash: hash,
        expiresAt: '2020-01-01T00:00:00.000Z',
        now,
      }),
    ).toBe(false)
    expect(
      shouldSkipExtract({
        storedHash: hash,
        sectionHash: hash,
        expiresAt: '2099-01-01T00:00:00.000Z',
        now,
      }),
    ).toBe(true)
  })
})

describe('FAL_PRICING_EXTRACT_CRON', () => {
  it('is a named nightly cron after the spec-sync shards', () => {
    expect(FAL_PRICING_EXTRACT_CRON).toBe('0 6 * * *')
    expect(FAL_PRICING_FETCH_CAP).toBe(200)
    expect(FAL_PRICING_EXTRACT_CAP).toBe(20)
    expect(FAL_PRICING_EXTRACT_MODEL).toBe('grok-4-fast')
    expect(
      (SPEC_SYNC_SHARD_CRONS as ReadonlyArray<string>).includes(
        FAL_PRICING_EXTRACT_CRON,
      ),
    ).toBe(false)
  })

  it('keeps wrangler.jsonc in lockstep', async () => {
    const fs = await import('node:fs/promises')
    const raw = await fs.readFile('wrangler.jsonc', 'utf8')
    expect(raw).toContain(`"${FAL_PRICING_EXTRACT_CRON}"`)
    expect(raw).toContain('"*/15 * * * *"')
    for (const cron of SPEC_SYNC_SHARD_CRONS) {
      expect(raw).toContain(`"${cron}"`)
    }
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

  it('returns unverified when the model refuses to guess', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ unverified: true }) } },
            ],
          }),
          { status: 200 },
        ),
      ),
    )
    try {
      await expect(extractRateCardWithGrok(args)).resolves.toBe('unverified')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails closed on a non-card payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"nope":true}' } }],
          }),
          { status: 200 },
        ),
      ),
    )
    try {
      await expect(extractRateCardWithGrok(args)).resolves.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
