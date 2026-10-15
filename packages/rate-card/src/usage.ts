/**
 * A provider's own usage object → the card's usage levers.
 *
 * Card levers are disjoint: `input_tokens` excludes the tokens billed at a
 * cache or modality lever, and `output_tokens` excludes any lever split out
 * of it. Providers report overlapping counts instead: OpenAI and Gemini
 * count cached tokens inside the prompt total, Anthropic does not. Pass the
 * usage object as the API returned it and `normalizeUsage` subtracts each
 * part from its total.
 *
 * Cache tokens always get their own lever, so a card with no cache rate
 * refuses them. Reasoning, audio, image and video tokens get their own
 * lever only when the card reads it; otherwise they stay in their total,
 * which is how the source bills them. A usage object in the card's own
 * vocabulary passes through unchanged.
 */
import { RateCardError, cardParams } from './evaluate.ts'
import type { RateCard } from './rate-card.schema.ts'

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

const FORMATS = Object.keys(FORMAT_KEYS) as NativeFormat[]

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

const isRecord = (v: unknown): v is Vars =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

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
  const reads = cardParams(card).usage
  const keys = Object.keys(usage)
  if (!keys.some((key) => NATIVE.has(key) && !reads.includes(key))) {
    return 'card'
  }
  const outside = (format: NativeFormat) =>
    keys.filter((key) => !FORMAT_KEYS[format].includes(key))
  const [closest] = [...FORMATS].sort(
    (a, b) => outside(a).length - outside(b).length,
  )
  if (closest === undefined) return 'card'
  const foreign = outside(closest)
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

/** A nested details object; a key this reader does not know throws. */
function details(value: unknown, path: string, known: string[]): Vars {
  if (value == null) return {}
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
  return value
}

const MODALITIES = { AUDIO: 'audio', IMAGE: 'image', VIDEO: 'video' } as const
type Modality = (typeof MODALITIES)[keyof typeof MODALITIES]

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
    const row = details(entry, `${path}[${i}]`, ['modality', 'tokenCount'])
    const modality =
      typeof row.modality === 'string'
        ? MODALITIES[row.modality as keyof typeof MODALITIES]
        : undefined
    if (modality) out[modality] += count(row.tokenCount, `${path}[${i}]`)
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
  parts: Array<[string, number]>,
): Record<string, number> {
  const out: Record<string, number> = {}
  let rest = total
  for (const [lever, n] of parts) {
    if (n < 0) {
      throw new RateCardError('bad-input', `usage: ${lever} is negative (${n})`)
    }
    if (n > 0 && (ALWAYS_SPLIT.has(lever) || reads.has(lever))) {
      out[lever] = (out[lever] ?? 0) + n
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
  // input_tokens includes cached_tokens; output_tokens includes reasoning.
  'openai-responses': (usage, reads) => {
    const input = details(usage.input_tokens_details, 'input_tokens_details', [
      'cached_tokens',
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
        count(usage.input_tokens, 'input_tokens'),
        [
          [
            'cache_read_tokens',
            count(input.cached_tokens, 'input_tokens_details.cached_tokens'),
          ],
        ],
      ),
      ...apportion(
        reads,
        'output_tokens',
        count(usage.output_tokens, 'output_tokens'),
        [
          [
            'reasoning_tokens',
            count(
              output.reasoning_tokens,
              'output_tokens_details.reasoning_tokens',
            ),
          ],
        ],
      ),
    }
  },
  // prompt_tokens includes cached and audio tokens; completion_tokens
  // includes reasoning, audio and both prediction counts.
  'openai-chat': (usage, reads) => {
    const prompt = details(
      usage.prompt_tokens_details,
      'prompt_tokens_details',
      ['cached_tokens', 'audio_tokens'],
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
        count(usage.prompt_tokens, 'prompt_tokens'),
        [
          [
            'cache_read_tokens',
            count(prompt.cached_tokens, 'prompt_tokens_details.cached_tokens'),
          ],
          [
            'audio_tokens',
            count(prompt.audio_tokens, 'prompt_tokens_details.audio_tokens'),
          ],
        ],
      ),
      ...apportion(
        reads,
        'output_tokens',
        count(usage.completion_tokens, 'completion_tokens'),
        [
          [
            'reasoning_tokens',
            count(
              completion.reasoning_tokens,
              'completion_tokens_details.reasoning_tokens',
            ),
          ],
          [
            'audio_output_tokens',
            count(
              completion.audio_tokens,
              'completion_tokens_details.audio_tokens',
            ),
          ],
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
      input_tokens: count(usage.input_tokens, 'input_tokens'),
      output_tokens: count(usage.output_tokens, 'output_tokens'),
      cache_read_tokens: count(
        usage.cache_read_input_tokens,
        'cache_read_input_tokens',
      ),
      ...apportion(
        reads,
        'cache_write_tokens',
        count(usage.cache_creation_input_tokens, 'cache_creation_input_tokens'),
        [
          [
            'cache_write_1h_tokens',
            count(
              creation.ephemeral_1h_input_tokens,
              'cache_creation.ephemeral_1h_input_tokens',
            ),
          ],
        ],
      ),
      web_searches: count(
        tools.web_search_requests,
        'server_tool_use.web_search_requests',
      ),
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
    const uncached = count(usage.promptTokenCount, 'promptTokenCount') - cached
    if (uncached < 0) {
      throw new RateCardError(
        'bad-input',
        `usage: cachedContentTokenCount ${cached} is more than promptTokenCount`,
      )
    }
    const modalities = Object.values(MODALITIES)
    return {
      ...apportion(
        reads,
        'input_tokens',
        uncached +
          count(usage.toolUsePromptTokenCount, 'toolUsePromptTokenCount'),
        modalities.map((m) => [`${m}_tokens`, prompt[m] - cache[m]]),
      ),
      ...apportion(
        reads,
        'cache_read_tokens',
        cached,
        modalities.map((m) => [`${m}_cache_tokens`, cache[m]]),
      ),
      ...apportion(
        reads,
        'output_tokens',
        count(usage.candidatesTokenCount, 'candidatesTokenCount') + thoughts,
        [
          ['reasoning_tokens', thoughts],
          ...modalities.map((m): [string, number] => [
            `${m}_output_tokens`,
            output[m],
          ]),
        ],
      ),
    }
  },
}

/**
 * `usage` in the card's lever vocabulary. A native OpenAI (Responses or
 * Chat Completions), Anthropic or Gemini (`usageMetadata`) usage object is
 * mapped to disjoint levers; card levers pass through. A zero lever the
 * card does not read is dropped, so a card with no cache rate still prices
 * a call that cached nothing. Throws `mixed-usage` for a payload that mixes
 * native fields and card levers.
 */
export function normalizeUsage(
  card: Pick<RateCard, 'inputs'>,
  usage: Vars,
): Vars {
  const format = usageFormat(card, usage)
  if (format === 'card') return usage
  const reads = new Set(cardParams(card).usage)
  return Object.fromEntries(
    Object.entries(NORMALIZERS[format](usage, reads)).filter(
      ([lever, n]) => n !== 0 || reads.has(lever),
    ),
  )
}
