/**
 * Chat Pricing sections whose billed price is tokens, compiled without an
 * LLM. Two shapes FAL actually publishes:
 *
 * - One `$X per N units` price, with input and output each costing a stated
 *   number of units, and a higher number past one token threshold. The
 *   threshold is the page's `128k` (1000, not 1024). "Over" is `>`, so the
 *   exact threshold stays on the under rate — the page never prices "at".
 *   Input and output cross it independently. Output length is the page's
 *   "reasoning + output", read as `output_tokens`.
 * - One `$X per N tokens` line and nothing else. The page does not split
 *   input from output, so both levers are that rate. A second amount, or
 *   the word input/output between the count and "tokens", is not this shape.
 *
 * Anything else returns null. The unit-rate parser still owns per-image,
 * per-second, and the other single-unit lines.
 */
import {
  rateCardSchema,
  verifyExamples,
  compileTokenCard,
} from '@modelschemas/rate-card'
import type { Expr, RateCard } from '@modelschemas/rate-card'

import { tokenCount } from '#/server/providers/model-facts.ts'

const PRICING_LINK = /For more details, see \[fal\.ai pricing\]\([^)]*\)\.?/gi

/** One `$X per N units` schedule. Groups: amount, count, threshold, inLow, inHigh, outLow, outHigh. */
const UNIT_SCHEDULE =
  /^your request will cost \$(\d+(?:\.\d+)?) per ([\d,]+) units\. for inputs under (\d+(?:\.\d+)?[km]) tokens, the units per input token is (\d+)\. for inputs of over \3 tokens, (\d+) units will be charged per token\. similarly, each output token costs (\d+) units, provided the total output length \(reasoning \+ output\) is under \3 tokens, and (\d+) units per token otherwise\.?$/i

/** The whole section is one undifferentiated token price. */
const FLAT_TOKENS =
  /^(?:-\s*)?(?:price:\s*)?\$(\d+(?:\.\d+)?) per ([\d,]+) tokens$/i

function pricingBody(section: string): string {
  // `markdownSection` keeps the `## Pricing` line. The rate starts after it.
  return section
    .replace(/\*\*/g, '')
    .replace(PRICING_LINK, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^##\s+pricing\s+/i, '')
}

function positive(text: string): number | null {
  const value = Number(text.replace(/,/g, ''))
  return Number.isFinite(value) && value > 0 ? value : null
}

function positiveInt(text: string): number | null {
  const value = positive(text)
  return value !== null && Number.isInteger(value) ? value : null
}

function quoteOf(section: string): string {
  const paragraphs = section
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^##\s+pricing$/i.test(part))
  return paragraphs[0] ?? section.trim()
}

function checked(card: RateCard): RateCard | null {
  const parsed = rateCardSchema.safeParse(card)
  if (!parsed.success) return null
  if (verifyExamples(parsed.data).some((result) => !result.ok)) return null
  return parsed.data
}

function rateOf(
  lever: 'input_tokens' | 'output_tokens',
  tier: 'base' | 'long',
): Expr {
  return { lookup: { table: 'rate', keys: [tier, lever] } }
}

/** `lever` billed at `long` only when that lever is over `threshold`. */
function leverPrice(
  lever: 'input_tokens' | 'output_tokens',
  threshold: number,
): Expr {
  return {
    '*': [
      { var: lever },
      {
        if: [
          { '>': [{ var: lever }, threshold] },
          rateOf(lever, 'long'),
          rateOf(lever, 'base'),
        ],
      },
    ],
  }
}

function scheduleCard(
  section: string,
  source: RateCard['source'],
): RateCard | null {
  const match = UNIT_SCHEDULE.exec(pricingBody(section).toLowerCase())
  if (!match) return null
  const amount = positive(match[1] ?? '')
  const count = positiveInt(match[2] ?? '')
  const threshold = tokenCount(match[3])
  const units = [match[4], match[5], match[6], match[7]].map((text) =>
    positiveInt(text ?? ''),
  )
  if (
    amount === null ||
    count === null ||
    threshold === null ||
    threshold <= 0 ||
    units.some((unit) => unit === null)
  ) {
    return null
  }
  const [inLow, inHigh, outLow, outHigh] = units as [
    number,
    number,
    number,
    number,
  ]
  const perUnit = amount / count
  const inputLow = perUnit * inLow
  const inputHigh = perUnit * inHigh
  const outputLow = perUnit * outLow
  const outputHigh = perUnit * outHigh
  const rates = [inputLow, inputHigh, outputLow, outputHigh]
  if (rates.some((rate) => !Number.isFinite(rate) || rate < 0)) return null
  const quote = quoteOf(section)
  const at = (tokens: number, perToken: number) => tokens * perToken
  return checked({
    inputs: {
      input_tokens: { param: 'input_tokens', bound: 'usage', kind: 'number' },
      output_tokens: {
        param: 'output_tokens',
        bound: 'usage',
        kind: 'number',
      },
    },
    tables: {
      rate: {
        base: { input_tokens: inputLow, output_tokens: outputLow },
        long: { input_tokens: inputHigh, output_tokens: outputHigh },
      },
    },
    price: {
      '+': [
        leverPrice('input_tokens', threshold),
        leverPrice('output_tokens', threshold),
      ],
    },
    examples: [
      {
        params: { input_tokens: count, output_tokens: 0 },
        usd: at(count, inputLow),
        quote,
      },
      {
        params: { input_tokens: 0, output_tokens: count },
        usd: at(count, outputLow),
        quote,
      },
      {
        params: { input_tokens: threshold, output_tokens: 0 },
        usd: at(threshold, inputLow),
        quote,
      },
      {
        params: { input_tokens: threshold + 1, output_tokens: 0 },
        usd: at(threshold + 1, inputHigh),
        quote,
      },
      {
        params: { input_tokens: 0, output_tokens: threshold + 1 },
        usd: at(threshold + 1, outputHigh),
        quote,
      },
    ],
    source,
  })
}

function flatCard(
  section: string,
  source: RateCard['source'],
): RateCard | null {
  const match = FLAT_TOKENS.exec(pricingBody(section).toLowerCase())
  if (!match) return null
  const amount = positive(match[1] ?? '')
  const count = positiveInt(match[2] ?? '')
  if (amount === null || count === null) return null
  const perToken = amount / count
  if (!Number.isFinite(perToken) || perToken <= 0) return null
  const card = compileTokenCard(
    { input_tokens: perToken, output_tokens: perToken },
    [],
    source,
  )
  if (card === null) return null
  const quote = quoteOf(section)
  return checked({
    ...card,
    examples: [
      {
        params: { input_tokens: count, output_tokens: 0 },
        usd: amount,
        quote,
      },
      {
        params: { input_tokens: 0, output_tokens: count },
        usd: amount,
        quote,
      },
    ],
  })
}

/**
 * Token card for a chat Pricing section, or null when this is not one of
 * the two shapes above. Never a per-image or per-second card.
 */
export function compileFalTokenCard(
  section: string,
  source: RateCard['source'],
): RateCard | null {
  return scheduleCard(section, source) ?? flatCard(section, source)
}
