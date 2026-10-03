import { describe, expect, it } from 'vitest'

import { compileTokenCard } from '@modelschemas/rate-card'

import { parseCoherePricing } from './cohere-pricing.ts'

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
