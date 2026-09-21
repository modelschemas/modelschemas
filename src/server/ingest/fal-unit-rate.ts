/**
 * FAL Pricing sections are overwhelmingly a single unit rate —
 * `- **Price**: $0.04 per megapixels`, `Your request will cost **$0.08** per
 * image.`, `**$0.045/sec**`. Compile those without an LLM (issue #70); only
 * the genuinely multi-rate pages fall through to the extract model.
 */
import { compileUnitCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

/** `$0.04`, `$**0.04**`, `**0.17** $` — FAL emits all three. */
const MONEY = String.raw`(?:\$[ \t]*\*{0,2}[ \t]*([0-9]+(?:\.[0-9]+)?)[ \t]*\*{0,2}|\*{0,2}[ \t]*([0-9]+(?:\.[0-9]+)?)[ \t]*\*{0,2}[ \t]*\$)`

function moneyRe(): RegExp {
  return new RegExp(MONEY, 'g')
}

function amountOf(match: RegExpExecArray): number {
  return Number(match[1] ?? match[2])
}

/** Every positive USD amount named anywhere in the section. */
export function usdAmounts(section: string): Array<number> {
  const found: Array<number> = []
  for (const match of section.matchAll(moneyRe())) {
    const amount = amountOf(match)
    if (Number.isFinite(amount) && amount > 0) found.push(amount)
  }
  return found
}

/** `$X per [N] <unit>` or `$X/<unit>`, the money in any of the three spellings. */
const UNIT_RATE = new RegExp(
  `${MONEY}[ \\t]*(?:per[ \\t]+|/)\\*{0,2}[ \\t]*([0-9][0-9,]*)?[ \\t]*\\*{0,2}[ \\t]*([A-Za-z]+(?:[ \\t]+[A-Za-z]+)?)`,
  'gi',
)

/**
 * Unit phrase → the card's quantity param. Anything not listed falls
 * through to the LLM rather than being guessed at.
 */
const UNIT_PARAMS: Record<string, string> = {
  second: 'seconds',
  seconds: 'seconds',
  sec: 'seconds',
  secs: 'seconds',
  'compute second': 'compute_seconds',
  'compute seconds': 'compute_seconds',
  'gpu second': 'compute_seconds',
  'gpu seconds': 'compute_seconds',
  'input second': 'input_seconds',
  'input seconds': 'input_seconds',
  'audio second': 'audio_seconds',
  'audio seconds': 'audio_seconds',
  'video second': 'video_seconds',
  'video seconds': 'video_seconds',
  minute: 'minutes',
  minutes: 'minutes',
  'compute minute': 'compute_minutes',
  'compute minutes': 'compute_minutes',
  'audio minute': 'audio_minutes',
  'audio minutes': 'audio_minutes',
  image: 'images',
  images: 'images',
  megapixel: 'megapixels',
  megapixels: 'megapixels',
  character: 'characters',
  characters: 'characters',
  word: 'words',
  words: 'words',
  generation: 'generations',
  generations: 'generations',
  video: 'videos',
  videos: 'videos',
  frame: 'frames',
  frames: 'frames',
  page: 'pages',
  pages: 'pages',
  request: 'requests',
  requests: 'requests',
  run: 'requests',
  runs: 'requests',
}

export interface FalUnitRate {
  /** USD for `count` units. */
  amount: number
  count: number
  /** Card input param the quantity binds to. */
  param: string
  /** The line the rate was read from, for the example's `quote`. */
  quote: string
}

function lineAt(section: string, index: number): string {
  const start = section.lastIndexOf('\n', index) + 1
  const end = section.indexOf('\n', index)
  return section.slice(start, end < 0 ? section.length : end).trim()
}

function paramFor(unit: string): string | undefined {
  const normalized = unit
    .toLowerCase()
    .replace(/[ \t]+/g, ' ')
    .trim()
  const words = normalized.split(' ')
  return (
    UNIT_PARAMS[normalized] ??
    (words.length > 1 ? UNIT_PARAMS[words[0] ?? ''] : undefined)
  )
}

/**
 * The section's single unit rate, or `null` when it names more than one
 * price, no price, or a unit we do not have a param for. Deliberately
 * fail-closed: a page with several rates is a table the LLM should read.
 */
/**
 * "For **$1.00**, you can run this model **25 times.**" restates the same
 * rate as a reciprocal. Drop it before counting distinct prices, or every
 * page carrying it would look multi-rate. The quote still comes from the
 * untouched text.
 */
const RECIPROCAL = /For[ \t]+\*{0,2}\$1(?:\.0{1,2})?\*{0,2}[^.]*\.(?:\*{0,2})/gi

export function parseFalUnitRate(section: string): FalUnitRate | null {
  const amounts = usdAmounts(section.replace(RECIPROCAL, ''))
  if (amounts.length === 0) return null
  if (new Set(amounts).size > 1) return null

  let rate: FalUnitRate | null = null
  for (const match of section.matchAll(UNIT_RATE)) {
    const amount = amountOf(match)
    if (!Number.isFinite(amount) || amount <= 0) return null
    const param = paramFor(match[4] ?? '')
    if (param === undefined) return null
    const count = Number((match[3] ?? '1').replace(/,/g, ''))
    if (!Number.isFinite(count) || count <= 0) return null
    const next: FalUnitRate = {
      amount,
      count,
      param,
      quote: lineAt(section, match.index),
    }
    // A repeated sentence is fine; two different rates are a table.
    if (
      rate &&
      (rate.amount !== amount || rate.count !== count || rate.param !== param)
    ) {
      return null
    }
    rate ??= next
  }
  return rate
}

/**
 * Compile the section's unit rate into a card with a synthesized one-unit
 * example quoting the source line, so `verifyExamples` has something real
 * to check. `null` when the section is not this shape.
 */
export function compileFalUnitCard(
  section: string,
  requestProperties: ReadonlySet<string>,
  source: RateCard['source'],
): RateCard | null {
  const rate = parseFalUnitRate(section)
  if (rate === null) return null
  const card = compileUnitCard(
    {
      quantity: {
        param: rate.param,
        // Only a real request field may be request-bound (#68); everything
        // else is a usage quantity the caller supplies.
        bound: requestProperties.has(rate.param) ? 'request' : 'usage',
      },
      rates: rate.amount / rate.count,
    },
    source,
  )
  if (card === null) return null
  return {
    ...card,
    examples: [
      {
        params: { [rate.param]: rate.count },
        usd: rate.amount,
        quote: rate.quote,
      },
    ],
  }
}
