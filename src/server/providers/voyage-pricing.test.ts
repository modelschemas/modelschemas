import { describe, expect, it } from 'vitest'

import { compileTokenCard } from '@modelschemas/rate-card'

import { parseVoyagePricing } from './voyage-pricing.ts'

const PAGE = `# Pricing

| Model | Price per thousand tokens | Price per million tokens | Number of free tokens |
| --- | --- | --- | --- |
| \`voyage-4-large\` | $0.00012 | $0.12 | 200 million |
| \`voyage-finance-2\`<br />\`voyage-law-2\`<br />\`voyage-code-2\` | $0.00012 | $0.12 | 50 million |

| Model | Price per million tokens | Price per billion pixels | Number of free tokens and pixels |
| --- | --- | --- | --- |
| \`voyage-multimodal-3.5\`<br />\`voyage-multimodal-3\` | $0.12 | $0.60 | 200M text tokens and 150B pixels |

| Model | Price per thousand tokens | Price per million tokens |
| --- | --- | --- |
| \`voyage-3-large\` | $0.00018 | $0.18 |
| \`voyage-3\` | $0.00006 | $0.06 |
| \`voyage-large-2\` | $0.00012 | $0.12 |
`

const SOURCE = {
  url: 'https://docs.voyageai.com/docs/pricing.md',
  hash: 'a'.repeat(64),
  extractedAt: '2026-10-03T00:00:00.000Z',
}

describe('voyage pricing page', () => {
  it('prices a listed model and leaves an unpriced id null', () => {
    const rates = parseVoyagePricing(PAGE)
    const priced = rates.get('voyage-3')
    expect(priced).toEqual({ inputTokens: 0.06 / 1e6 })
    expect(
      priced
        ? compileTokenCard({ input_tokens: priced.inputTokens }, [], SOURCE)
        : null,
    ).toMatchObject({
      tables: { rate: { base: { input_tokens: 0.06 / 1e6 } } },
    })
    expect(rates.get('voyage-3-large')?.inputTokens).toBe(0.18 / 1e6)
    expect(rates.get('voyage-law-2')?.inputTokens).toBe(0.12 / 1e6)
    const multi = rates.get('voyage-multimodal-3')
    expect(multi).toEqual({ inputTokens: 0.12 / 1e6, pixels: 0.6 / 1e9 })
    expect(
      multi
        ? compileTokenCard(
            { input_tokens: multi.inputTokens, pixels: multi.pixels ?? 0 },
            [],
            SOURCE,
          )
        : null,
    ).toMatchObject({
      inputs: {
        input_tokens: { bound: 'usage' },
        pixels: { bound: 'usage' },
      },
    })
    expect(rates.has('voyage-not-on-the-page')).toBe(false)
  })
})
