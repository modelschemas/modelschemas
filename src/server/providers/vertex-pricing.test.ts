import { describe, expect, it } from 'vitest'

import { compileTokenCard } from '@modelschemas/rate-card'

import { normModelName } from './vertex-text.ts'
import { baseRates, parseVertexPricing, priceLevers } from './vertex-pricing.ts'

const NOW = Date.UTC(2026, 9, 6)

function table(header: string, rows: Array<string>): string {
  const head = header
    .split('|')
    .map((cell) => `<th>${cell.trim()}</th>`)
    .join('')
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .split('|')
          .map((cell) => `<td>${cell.trim()}</td>`)
          .join('')}</tr>`,
    )
    .join('')
  return `<table><tr>${head}</tr>${body}</table>`
}

const HEADER =
  'Model | Type | Region | Price (/1M tokens) <= 200K input tokens | Price (/1M tokens) > 200K input tokens | Price (/1M tokens) <= 200K cached input tokens | Price (/1M tokens) > 200K cached input tokens'

const PRICING = [
  table(HEADER, [
    'Gemini 3.1 Pro Preview | Input (text, image, video, audio) | Global | $2.00 | $4.00 | $0.20 | $0.40',
    '| Text output (response and reasoning) | Global | $12.00 | $18.00 | N/A | N/A',
    'Gemini 3.1 Pro Preview | Input (text, image, video, audio) | Non-global | $2.20 | $4.40 | $0.22 | $0.44',
    '| Text output (response and reasoning) | Non-global | $13.20 | $19.80 | N/A | N/A',
    'Gemini 3.8 Flash* through December 31, 2026 | Input (text, image, video, audio) | Global | $0.75 | $0.75 | $0.075 | $0.075',
    '| Text output (response and reasoning) | Global | $3.75 | $3.75 | N/A | N/A',
    'Gemini 3.8 Flash Starting January 1, 2027 | Input (text, image, video, audio) | Global | $1.50 | $1.50 | $0.15 | $0.15',
    '| Text output (response and reasoning) | Global | $7.50 | $7.50 | N/A | N/A',
    'Gemini 2.5 Flash | Input (text, image, video) | Global | $0.30 | $0.30 | $0.03 | $0.03',
    '| Audio Input | Global | $1.00 | $1.00 | $0.10 | $0.10',
    '| Text output (response and reasoning) | Global | $2.50 | $2.50 | N/A | N/A',
    'Gemini 3.1 Flash-Lite | Input (text, image, video) | Global | $0.25 | $0.25 | $0.025 | $0.025',
    '| Input (audio) | Global | $0.50 | $0.50 | $0.05 | $0.05',
    '| Text output (response and reasoning) | Global | $1.50 | $1.50 | N/A | N/A',
    'Gemini 3 Pro Image | Input (text, image) | Global | $2.00 | $4.00 | N/A | N/A',
    '| Text output (response and reasoning) | Global | $12.00 | $18.00 | N/A | N/A',
    '| Image output per picture | Global | $0.13 | N/A | N/A | N/A',
    'Gemini 2.5 Pro Computer Use-Preview | Input (text, image, video, audio) | | $1.25 | $2.50 | N/A | N/A',
    '| Text output (response and reasoning) | | $10.00 | $15.00 | N/A | N/A',
  ]),
  table(
    'Model | Type | Region | Price (/1M tokens) <= 200K input tokens with Priority | Price (/1M tokens) > 200K input tokens with Priority | Price (/1M tokens) <= 200K cached input tokens with Priority | Price (/1M tokens) > 200K cached input tokens with Priority',
    [
      'Gemini 3.1 Pro Preview | Input (text, image, video, audio) | Global | $9.00 | $9.00 | N/A | N/A',
      '| Text output (response and reasoning) | Global | $90.00 | $90.00 | N/A | N/A',
    ],
  ),
].join('')

describe('parseVertexPricing', () => {
  const parsed = parseVertexPricing(PRICING, NOW)

  it('keeps the global standard rate and the long-context tier', () => {
    const rates = parsed.get(normModelName('Gemini 3.1 Pro'))
    expect(rates?.base.input_tokens).toBe(2 / 1e6)
    expect(rates?.base.output_tokens).toBe(12 / 1e6)
    expect(rates?.base.cache_read_tokens).toBe(0.2 / 1e6)
    expect(rates?.tiers).toEqual([
      {
        minPromptTokens: 200_000,
        rates: {
          input_tokens: 4 / 1e6,
          output_tokens: 18 / 1e6,
          cache_read_tokens: 0.4 / 1e6,
        },
      },
    ])
    const card = compileTokenCard(rates?.base ?? {}, rates?.tiers ?? [], {
      url: 'https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing',
      hash: 'a'.repeat(64),
      extractedAt: '2026-10-06T00:00:00.000Z',
    })
    expect(card && baseRates(card).input_tokens).toBe(2 / 1e6)
  })

  it('uses the introductory row that is in effect', () => {
    const rates = parsed.get(normModelName('Gemini 3.8 Flash'))
    expect(rates?.base.input_tokens).toBe(0.75 / 1e6)
    expect(rates?.base.output_tokens).toBe(3.75 / 1e6)
    expect(rates?.expiresAt).toBe('2027-01-01T00:00:00.000Z')
    expect(rates?.tiers).toEqual([])
  })

  it('prices audio on its own lever', () => {
    const rates = parsed.get(normModelName('Gemini 2.5 Flash'))
    expect(rates?.base.audio_tokens).toBe(1 / 1e6)
    expect(rates?.base.input_tokens).toBe(0.3 / 1e6)
    const lite = parsed.get(normModelName('Gemini 3.1 Flash-Lite'))
    expect(lite?.base.input_tokens).toBe(0.25 / 1e6)
    expect(lite?.base.audio_tokens).toBe(0.5 / 1e6)
    expect(lite?.base.output_tokens).toBe(1.5 / 1e6)
  })

  it('drops a model whose output price is not a token rate', () => {
    expect(parsed.has(normModelName('Gemini 3 Pro Image'))).toBe(false)
  })

  it('ignores computer-use and priority tables', () => {
    expect(parsed.has(normModelName('Gemini 2.5 Pro Computer Use'))).toBe(false)
    expect(priceLevers('Image output per picture')).toBeNull()
  })

  it('prices the image models from the table with no 200K split', () => {
    const flat = parseVertexPricing(
      [
        table(
          'Model | Type | Region | Price (/1M tokens) | Price (/1M tokens) cached input tokens',
          [
            'Gemini 3.1 Flash Image (Nano Banana 2) | Input (text, image, video) | Global | $0.50 | $0.05',
            '| | Non-global | $0.55 | $0.055',
            '| Text output (response and reasoning) | Global | $3.00 | N/A',
            '| | Non-global | $3.30 | N/A',
            '| Image Output | Global | $60.00 | N/A',
            '| | Non-global | $66.00 | N/A',
          ],
        ),
        table(
          'Model | Type | Region | Price (/1M tokens) with Priority | Price (/1M tokens) cached input tokens with Priority',
          [
            'Gemini 3.1 Flash Image (Nano Banana 2) | Input (text, image, video) | Global | $0.90 | $0.09',
          ],
        ),
        // No cached column: an open-model table, not the standard one.
        table('Model | Type | Price (/1M tokens)', [
          'Gemini Omni Flash | Input (text, image, video, audio) | $1.50',
          '| Text output (response and reasoning) | $9.00',
        ]),
      ].join(''),
      NOW,
    )
    expect(
      flat.get(normModelName('Gemini 3.1 Flash Image (Nano Banana 2)')),
    ).toEqual({
      base: {
        input_tokens: 0.5 / 1e6,
        cache_read_tokens: 0.05 / 1e6,
        output_tokens: 3 / 1e6,
        image_output_tokens: 60 / 1e6,
      },
      tiers: [],
    })
    expect(flat.size).toBe(1)
  })
})
