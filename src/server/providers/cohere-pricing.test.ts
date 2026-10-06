import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { compileTokenCard } from '@modelschemas/rate-card'

import { parseCoherePricing } from './cohere-pricing.ts'

// The pricing groups of https://cohere.com/pricing as its data payload
// carries them, and the legacy FAQ, fetched 2026-10-07.
const LIVE_PAGE = readFileSync(
  new URL('./fixtures/cohere-pricing.html.txt', import.meta.url),
  'utf8',
)
const LIVE_IDS = [
  'command-a-plus-05-2026',
  'command-a-03-2025',
  'command-r7b-12-2024',
  'command-r-08-2024',
  'command-r-plus-08-2024',
  'north-mini-code-1-0',
]

describe('cohere pricing cards', () => {
  it('prices the one live dated id under a card name', () => {
    const rates = parseCoherePricing(LIVE_PAGE, '', LIVE_IDS)
    expect(rates.get('command-r-08-2024')).toEqual({
      input_tokens: 1.5e-7,
      output_tokens: 6e-7,
    })
    expect(rates.get('command-r7b-12-2024')).toEqual({
      input_tokens: 3.75e-8,
      output_tokens: 1.5e-7,
    })
    // The FAQ sentence, not a card.
    expect(rates.get('command-r-plus-08-2024')?.input_tokens).toBe(2.5e-6)
    // "Free" cards, search and page prices, and Embed's one "Cost" figure
    // are not token prices for a chat id.
    expect([...rates.keys()].sort()).toEqual([
      'command-r-03-2024',
      'command-r-08-2024',
      'command-r-plus-04-2024',
      'command-r-plus-08-2024',
      'command-r7b-12-2024',
    ])
  })

  it('gives no card when the name fits no live id, or several', () => {
    expect(
      parseCoherePricing(LIVE_PAGE, '', ['command-r-plus-08-2024']).has(
        'command-r-08-2024',
      ),
    ).toBe(false)
    const two = parseCoherePricing(LIVE_PAGE, '', [
      'command-r-08-2024',
      'command-r-02-2027',
    ])
    expect(two.has('command-r-08-2024')).toBe(false)
    expect(two.has('command-r-02-2027')).toBe(false)
  })

  it('drops a card whose price block is reshaped', () => {
    const ids = ['command-r7b-12-2024']
    const mutated = (from: string, to: string) => {
      expect(LIVE_PAGE).toContain(from)
      return parseCoherePricing(LIVE_PAGE.replace(from, to), '', ids)
    }
    expect(mutated('', '').has('command-r7b-12-2024')).toBe(true)
    for (const [from, to] of [
      // A different unit.
      [
        '\\"modelName\\":\\"Command R7B\\",\\"per\\":\\"1M tokens\\"',
        '\\"modelName\\":\\"Command R7B\\",\\"per\\":\\"1K tokens\\"',
      ],
      // A thousands separator must not parse as its leading digits.
      ['\\"inputPrice\\":0.0375,', '\\"inputPrice\\":\\"1,037.50\\",'],
      // A batch or cached label is not the standard input price.
      [
        '\\"inputLabel\\":\\"Input\\",\\"inputPrice\\":0.0375',
        '\\"inputLabel\\":\\"Batch input\\",\\"inputPrice\\":0.0375',
      ],
      // A per-unit override on the price row.
      [
        '\\"inputPrice\\":0.0375,\\"outputLabel\\":\\"Output\\",\\"outputPrice\\":0.15}',
        '\\"inputPrice\\":0.0375,\\"outputLabel\\":\\"Output\\",\\"outputPrice\\":0.15,\\"overridePer\\":\\"1K tokens\\"}',
      ],
      // A second price row (a tier) leaves no single standard price.
      [
        '\\"outputPrice\\":0.15}]',
        '\\"outputPrice\\":0.15},{\\"_key\\":\\"x\\",\\"_type\\":\\"pricing\\",\\"inputLabel\\":\\"Input\\",\\"inputPrice\\":1,\\"outputLabel\\":\\"Output\\",\\"outputPrice\\":2}]',
      ],
      ['\\"inputPrice\\":0.0375,', '\\"inputPrice\\":0,'],
    ] as const) {
      expect(mutated(from, to).has('command-r7b-12-2024'), from).toBe(false)
    }
  })
})

const PAGE = `<p>For existing customers:</p>
<ul>
<li>Command pricing is $1.00/1M tokens for input and $2.00/1M tokens for output</li>
<li>Command-light pricing is $0.30/1M tokens for input and $0.60/1M tokens for output</li>
<li>Command R 03-2024 pricing is $0.50/1M tokens for input and $1.50/1M tokens for output</li>
<li>Command R+ 04-2024 pricing is $3.00/1M tokens for input and $15.00/1M tokens for output</li>
</ul>
<p>Command R+ 08-2024 pricing is $2.50/1M tokens for input and $10.00/1M tokens for output</p>
<p>Aya Expanse models (8B and 32B) on the API are charged at $0.50/1M tokens for input and $1.50/1M tokens for output.</p>
<p>Command A+ is free until rate limits are reached.</p>`

const AYA = `| \`c4ai-aya-expanse-32b\` | Aya Expanse 32B |`

describe('cohere pricing page', () => {
  it('prices dated Command R rows and the Aya id the model page names', () => {
    const rates = parseCoherePricing(PAGE, AYA)
    expect(rates.get('command-r-plus-08-2024')).toEqual({
      input_tokens: 2.5 / 1e6,
      output_tokens: 10 / 1e6,
    })
    expect(rates.get('command-r-03-2024')?.input_tokens).toBe(0.5 / 1e6)
    expect(rates.get('c4ai-aya-expanse-32b')?.output_tokens).toBe(1.5 / 1e6)
    const card = compileTokenCard(
      rates.get('command-r-plus-08-2024') ?? {},
      [],
      {
        url: 'https://cohere.com/pricing',
        hash: 'abc',
        extractedAt: '2026-10-03',
      },
    )
    expect(card).not.toBeNull()
    // No API id in the sentence, and Command A+ publishes no token price.
    expect(rates.has('command')).toBe(false)
    expect(rates.has('command-light')).toBe(false)
    expect(rates.has('command-a-03-2025')).toBe(false)
    expect(rates.has('command-a-plus-05-2026')).toBe(false)
    expect(rates.has('c4ai-aya-expanse-8b')).toBe(false)
  })
})
