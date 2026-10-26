/**
 * A provider's own usage object → the card's usage levers.
 *
 * Card levers are disjoint: `input_tokens` excludes the tokens billed at a
 * cache or modality lever, and `output_tokens` excludes any lever split out
 * of it. Providers report overlapping counts instead: OpenAI and Gemini
 * count cached tokens and cache writes inside the prompt total, Anthropic
 * does not. Pass the usage object as the API returned it and
 * `normalizeUsage` subtracts each part from its total.
 *
 * Cache reads and cache writes always get their own lever, so a card with
 * no rate for that lever refuses them. Reasoning, audio, image and video
 * tokens get their own lever only when the card reads it; otherwise they
 * stay in their total,
 * which is how the source bills them. A usage object in the card's own
 * vocabulary passes through, except a zero lever the card does not read,
 * which is dropped.
 */
import { RateCardError, cardParams, isRecord } from './evaluate.ts'
import type { RateCard } from './card.ts'

type Vars = Record<string, unknown>

export type UsageFormat =
  | 'card'
  | 'openai-responses'
  | 'openai-chat'
  | 'anthropic'
  | 'gemini'

type NativeFormat = Exclude<UsageFormat, 'card'>

/** Top-level keys of each native usage object. */
const FORMAT_KEYS: Record<NativeFormat, readonly string[]> = {
  'openai-responses': [
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'input_tokens_details',
    'output_tokens_details',
  ],
  'openai-chat': [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'prompt_tokens_details',
    'completion_tokens_details',
  ],
  anthropic: [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'cache_creation',
    'server_tool_use',
    'service_tier',
  ],
  gemini: [
    'promptTokenCount',
    'cachedContentTokenCount',
    'candidatesTokenCount',
    'thoughtsTokenCount',
    'toolUsePromptTokenCount',
    'totalTokenCount',
    'promptTokensDetails',
    'cacheTokensDetails',
    'candidatesTokensDetails',
    'toolUsePromptTokensDetails',
    'trafficType',
  ],
}

const FORMATS = Object.keys(FORMAT_KEYS) as [NativeFormat, ...NativeFormat[]]

/**
 * Keys that do not mark a native format: card levers that a native format
 * also uses with its own meaning, and totals, which price nothing.
 */
const NOT_MARKERS = new Set([
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'totalTokenCount',
])

const NATIVE = new Set(
  Object.values(FORMAT_KEYS)
    .flat()
    .filter((key) => !NOT_MARKERS.has(key)),
)

/** Levers split out even when the card does not read them. */
const ALWAYS_SPLIT = new Set([
  'cache_read_tokens',
  'cache_write_tokens',
  'cache_write_1h_tokens',
])

/**
 * The format of a usage object: `card` when it has no key that only a
 * provider's usage object has. A key the card reads is a card lever (the
 * Seedance cards read `completion_tokens`). A key from another format, or
 * a card lever beside native keys, throws `mixed-usage`.
 */
export function usageFormat(
  card: Pick<RateCard, 'inputs'>,
  usage: Vars,
): UsageFormat {
  const keys = Object.keys(usage)
  const marked = keys.filter((key) => NATIVE.has(key))
  if (marked.length === 0) return 'card'
  const reads = cardParams(card).usage
  if (marked.every((key) => reads.includes(key))) return 'card'
  let closest: NativeFormat = FORMATS[0]
  let foreign = keys
  for (const format of FORMATS) {
    const outside = keys.filter((key) => !FORMAT_KEYS[format].includes(key))
    if (outside.length < foreign.length) {
      closest = format
      foreign = outside
    }
  }
  if (foreign.length > 0) {
    throw new RateCardError(
      'mixed-usage',
      `${foreign.map((key) => `usage.${key}`).join(', ')}: not a field of ${closest} usage. ` +
        'Send the provider usage object as returned, or card levers only, not both',
    )
  }
  return closest
}

function count(value: unknown, path: string): number {
  if (value == null) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RateCardError(
      'bad-input',
      `usage.${path}: expected a token count, got ${JSON.stringify(value)}`,
    )
  }
  return value
}

/** A format total. Missing is an incomplete bill, not a zero. */
function requiredCount(value: unknown, path: string): number {
  if (value == null) {
    throw new RateCardError(
      'bad-input',
      `usage.${path}: expected a token count, got ${JSON.stringify(value)}`,
    )
  }
  return count(value, path)
}

/**
 * A count reader over a nested details object. A key this reader does not
 * know throws.
 */
function details(
  value: unknown,
  path: string,
  known: string[],
): (key: string) => number {
  if (value == null) return () => 0
  if (!isRecord(value)) {
    throw new RateCardError(
      'bad-input',
      `usage.${path}: expected an object, got ${JSON.stringify(value)}`,
    )
  }
  const unknown = Object.keys(value).filter((key) => !known.includes(key))
  if (unknown.length > 0) {
    throw new RateCardError(
      'unknown-usage-key',
      `${unknown.map((key) => `usage.${path}.${key}`).join(', ')}: not read by the usage normalizer`,
    )
  }
  return (key) => count(value[key], `${path}.${key}`)
}

type Modality = 'audio' | 'image' | 'video'

const MODALITIES: Modality[] = ['audio', 'image', 'video']

/** Gemini `[{ modality, tokenCount }]` → tokens per priced modality. */
function byModality(value: unknown, path: string): Record<Modality, number> {
  const out: Record<Modality, number> = { audio: 0, image: 0, video: 0 }
  if (value == null) return out
  if (!Array.isArray(value)) {
    throw new RateCardError(
      'bad-input',
      `usage.${path}: expected a list, got ${JSON.stringify(value)}`,
    )
  }
  value.forEach((entry: unknown, i) => {
    const tokens = details(entry, `${path}[${i}]`, ['modality', 'tokenCount'])
    const modality = MODALITIES.find(
      (m) => isRecord(entry) && entry.modality === m.toUpperCase(),
    )
    if (modality) out[modality] += tokens('tokenCount')
  })
  return out
}

/**
 * `total` split into `base` and the parts that get their own lever. A part
 * stays in `base` unless it always splits or the card reads its lever.
 */
function apportion(
  reads: Set<string>,
  base: string,
  total: number,
  parts: Array<[lever: string, n: number]>,
): Record<string, number> {
  const out: Record<string, number> = {}
  let rest = total
  for (const [lever, n] of parts) {
    if (n < 0) {
      throw new RateCardError('bad-input', `usage: ${lever} is negative (${n})`)
    }
    if (n > 0 && (ALWAYS_SPLIT.has(lever) || reads.has(lever))) {
      out[lever] = n
      rest -= n
    }
  }
  if (rest < 0) {
    throw new RateCardError(
      'bad-input',
      `usage: the parts of ${base} add up to more than its total ${total}`,
    )
  }
  out[base] = rest
  return out
}

type Normalizer = (usage: Vars, reads: Set<string>) => Record<string, number>

const NORMALIZERS: Record<NativeFormat, Normalizer> = {
  // input_tokens includes cached_tokens and cache_write_tokens.
  // output_tokens includes reasoning.
  'openai-responses': (usage, reads) => {
    const input = details(usage.input_tokens_details, 'input_tokens_details', [
      'cached_tokens',
      'cache_write_tokens',
    ])
    const output = details(
      usage.output_tokens_details,
      'output_tokens_details',
      ['reasoning_tokens'],
    )
    return {
      ...apportion(
        reads,
        'input_tokens',
        requiredCount(usage.input_tokens, 'input_tokens'),
        [
          ['cache_read_tokens', input('cached_tokens')],
          ['cache_write_tokens', input('cache_write_tokens')],
        ],
      ),
      ...apportion(
        reads,
        'output_tokens',
        requiredCount(usage.output_tokens, 'output_tokens'),
        [['reasoning_tokens', output('reasoning_tokens')]],
      ),
    }
  },
  // prompt_tokens includes cached, audio and image tokens. text_tokens
  // is the remainder already inside that total, so it is accepted and
  // not subtracted. completion_tokens includes reasoning, audio and both
  // prediction counts.
  'openai-chat': (usage, reads) => {
    const prompt = details(
      usage.prompt_tokens_details,
      'prompt_tokens_details',
      [
        'cached_tokens',
        'cache_write_tokens',
        'audio_tokens',
        'image_tokens',
        'text_tokens',
      ],
    )
    const completion = details(
      usage.completion_tokens_details,
      'completion_tokens_details',
      [
        'reasoning_tokens',
        'audio_tokens',
        'accepted_prediction_tokens',
        'rejected_prediction_tokens',
      ],
    )
    return {
      ...apportion(
        reads,
        'input_tokens',
        requiredCount(usage.prompt_tokens, 'prompt_tokens'),
        [
          ['cache_read_tokens', prompt('cached_tokens')],
          ['cache_write_tokens', prompt('cache_write_tokens')],
          ['audio_tokens', prompt('audio_tokens')],
          ['image_tokens', prompt('image_tokens')],
        ],
      ),
      ...apportion(
        reads,
        'output_tokens',
        requiredCount(usage.completion_tokens, 'completion_tokens'),
        [
          ['reasoning_tokens', completion('reasoning_tokens')],
          ['audio_output_tokens', completion('audio_tokens')],
        ],
      ),
    }
  },
  // input_tokens excludes cache reads and writes; cache_creation splits
  // the writes by TTL.
  anthropic: (usage, reads) => {
    const creation = details(usage.cache_creation, 'cache_creation', [
      'ephemeral_5m_input_tokens',
      'ephemeral_1h_input_tokens',
    ])
    const tools = details(usage.server_tool_use, 'server_tool_use', [
      'web_search_requests',
      'web_fetch_requests',
    ])
    return {
      input_tokens: requiredCount(usage.input_tokens, 'input_tokens'),
      output_tokens: requiredCount(usage.output_tokens, 'output_tokens'),
      cache_read_tokens: count(
        usage.cache_read_input_tokens,
        'cache_read_input_tokens',
      ),
      ...apportion(
        reads,
        'cache_write_tokens',
        count(usage.cache_creation_input_tokens, 'cache_creation_input_tokens'),
        [['cache_write_1h_tokens', creation('ephemeral_1h_input_tokens')]],
      ),
      web_searches: tools('web_search_requests'),
    }
  },
  // promptTokenCount includes cachedContentTokenCount; thoughtsTokenCount
  // and toolUsePromptTokenCount are outside the prompt and candidates.
  gemini: (usage, reads) => {
    const cached = count(
      usage.cachedContentTokenCount,
      'cachedContentTokenCount',
    )
    const prompt = byModality(usage.promptTokensDetails, 'promptTokensDetails')
    const cache = byModality(usage.cacheTokensDetails, 'cacheTokensDetails')
    const output = byModality(
      usage.candidatesTokensDetails,
      'candidatesTokensDetails',
    )
    const thoughts = count(usage.thoughtsTokenCount, 'thoughtsTokenCount')
    const uncached =
      requiredCount(usage.promptTokenCount, 'promptTokenCount') - cached
    if (uncached < 0) {
      throw new RateCardError(
        'bad-input',
        `usage: cachedContentTokenCount ${cached} is more than promptTokenCount`,
      )
    }
    return {
      ...apportion(
        reads,
        'input_tokens',
        uncached +
          count(usage.toolUsePromptTokenCount, 'toolUsePromptTokenCount'),
        MODALITIES.map((m) => [`${m}_tokens`, prompt[m] - cache[m]]),
      ),
      ...apportion(
        reads,
        'cache_read_tokens',
        cached,
        MODALITIES.map((m) => [`${m}_cache_tokens`, cache[m]]),
      ),
      ...apportion(
        reads,
        'output_tokens',
        requiredCount(usage.candidatesTokenCount, 'candidatesTokenCount') +
          thoughts,
        [
          ['reasoning_tokens', thoughts],
          ...MODALITIES.map((m): [string, number] => [
            `${m}_output_tokens`,
            output[m],
          ]),
        ],
      ),
    }
  },
}

/**
 * Drop a zero lever the card does not read. The same object when nothing
 * drops, so a card-lever payload with no such zero stays the caller's.
 */
function withoutUnreadZeros(reads: ReadonlySet<string>, levers: Vars): Vars {
  const dropped = Object.keys(levers).filter(
    (lever) => levers[lever] === 0 && !reads.has(lever),
  )
  if (dropped.length === 0) return levers
  const kept = { ...levers }
  for (const lever of dropped) delete kept[lever]
  return kept
}

/**
 * `usage` in the card's lever vocabulary. A native OpenAI (Responses or
 * Chat Completions), Anthropic or Gemini (`usageMetadata`) usage object is
 * mapped to disjoint levers; card levers pass through. A zero lever the
 * card does not read is dropped, whether it arrived as a card lever or
 * from a native usage object, so a card with no cache rate still prices a
 * call that cached nothing. A non-zero lever the card does not read is
 * left in place; `priceDetailed` throws `unknown-usage-key` for it.
 * Throws `mixed-usage` for a payload that mixes native fields and card
 * levers.
 */
export function normalizeUsage(
  card: Pick<RateCard, 'inputs'>,
  usage: Vars,
): Vars {
  const format = usageFormat(card, usage)
  const reads = new Set(cardParams(card).usage)
  const levers = format === 'card' ? usage : NORMALIZERS[format](usage, reads)
  return withoutUnreadZeros(reads, levers)
}
