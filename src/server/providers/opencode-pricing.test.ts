import { price } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'
import { describe, expect, it } from 'vitest'

import {
  OPENCODE_PRICING_URL,
  parseOpenCodePricing,
} from './opencode-pricing.ts'

/** Excerpt-shaped page. Names and prices are fixtures, not a live snapshot. */
const PAGE = `---
title: "Models"
---

## Endpoints

| Model           | Model ID     | Endpoint                                              | AI SDK Package      |
| --------------- | ------------ | ----------------------------------------------------- | ------------------- |
| Opus            | opus         | \`https://opencode.ai/inference/anthropic/v1/messages\` | \`@ai-sdk/anthropic\` |
| GPT             | gpt          | \`https://opencode.ai/inference/openai/v1/responses\`   | \`@ai-sdk/openai\`    |
| Mistral         | mistral      | \`https://opencode.ai/inference/openai/v1/chat\`        | \`@ai-sdk/openai\`    |
| Jev             | jev          | \`https://opencode.ai/inference/systemone/v1/systemone\` | -                  |
| Pickle          | pickle       | \`https://opencode.ai/inference/openai/v1/chat\`        | \`@ai-sdk/openai\`    |

These packages are for applications.

## Pricing

Below are the prices **per 1M tokens**.

| Model                             | Input           | Output          | Cached Read     | Cached Write |
| --------------------------------- | --------------- | --------------- | --------------- | ------------ |
| Pickle                            | Free            | Free            | Free            | -            |
| Jev                               | $0.042          | Free            | -               | -            |
| Mistral (50% off)                 | ~~$1.36~~ $0.68 | ~~$4.18~~ $2.09 | ~~$0.14~~ $0.07 | -            |
| Opus                              | $4.00           | $20.00          | $0.20           | $5.00        |
| GPT (≤ 272K tokens)               | $5.00           | $30.00          | $0.50           | -            |
| GPT (> 272K tokens)               | $10.00          | $45.00          | $1.00           | -            |

**Mistral:** The 50% discount applies through November 30, 2026.

## Privacy
`

const doc = (text: string) => ({
  text,
  hash: 'a'.repeat(64),
  extractedAt: '2026-10-18T00:00:00.000Z',
})

type Card = RateCard & {
  tables: { rate: Record<string, Record<string, number>> }
}

describe('parseOpenCodePricing', () => {
  it('joins prices to ids, with tiers, discounts and free rows', () => {
    const cards = parseOpenCodePricing(doc(PAGE))
    expect([...cards.keys()].sort()).toEqual([
      'gpt',
      'jev',
      'mistral',
      'opus',
      'pickle',
    ])
    const card = (id: string) => cards.get(id) as Card
    expect(card('opus').source.url).toBe(OPENCODE_PRICING_URL)
    expect(card('opus').tables.rate).toEqual({
      base: {
        input_tokens: 4 / 1e6,
        output_tokens: 20 / 1e6,
        cache_read_tokens: 0.2 / 1e6,
        cache_write_tokens: 5 / 1e6,
      },
    })
    expect(card('gpt').tables.rate).toEqual({
      base: {
        input_tokens: 5 / 1e6,
        output_tokens: 30 / 1e6,
        cache_read_tokens: 0.5 / 1e6,
      },
      '272000': {
        input_tokens: 10 / 1e6,
        output_tokens: 45 / 1e6,
        cache_read_tokens: 1 / 1e6,
      },
    })
    // The billed price, not the struck-through list price.
    expect(card('mistral').tables.rate.base?.input_tokens).toBe(0.68 / 1e6)
    expect(
      price(card('jev'), {}, { input_tokens: 1_000_000, output_tokens: 5 }),
    ).toBeCloseTo(0.042)
    expect(card('pickle')).toMatchObject({ price: 0 })
    expect(
      price(card('pickle'), {}, { input_tokens: 10, output_tokens: 10 }),
    ).toBe(0)
  })

  it.each([
    [
      'an unreadable cell',
      PAGE.replace('$4.00 ', 'TBD   '),
      /unreadable price TBD/,
    ],
    [
      'a changed header',
      PAGE.replace('Cached Write', 'Cache Write '),
      /Pricing header changed/,
    ],
    [
      'a row naming no id',
      PAGE.replace('| Opus      ', '| Opus 9    '),
      /names no model id/,
    ],
    [
      'a tier with no pair',
      PAGE.replace(/\| GPT \(> 272K.*\n/, ''),
      /unreadable context tiers/,
    ],
    [
      'mismatched tier thresholds',
      PAGE.replace('≤ 272K', '≤ 200K'),
      /unreadable context tiers/,
    ],
    [
      'a tier that drops a lever',
      PAGE.replace(
        '| $10.00          | $45.00          | $1.00 ',
        '| $10.00          | $45.00          | -     ',
      ),
      /changes the levers/,
    ],
    [
      'a duplicate price row',
      PAGE.replace(/^\| Opus {2}.*\$4\.00.*$/m, (row) => `${row}\n${row}`),
      /duplicate price row/,
    ],
    [
      'no output price',
      PAGE.replace(
        '| $4.00           | $20.00 ',
        '| $4.00           | -      ',
      ),
      /omits input or output/,
    ],
    [
      'a price table that ends early',
      PAGE.replace('\n| GPT (≤', '\n\n| GPT (≤'),
      /has an endpoint but no price row/,
    ],
    [
      'no Pricing section',
      PAGE.replace('## Pricing', '## Prices'),
      /has no Pricing/,
    ],
    [
      'an empty table',
      PAGE.replace(/\| (Pickle|Jev|Mistral|Opus|GPT) .*\n/g, ''),
      /unreadable/,
    ],
  ])('throws on %s', (_, text, message) => {
    expect(() => parseOpenCodePricing(doc(text))).toThrow(message)
  })
})
