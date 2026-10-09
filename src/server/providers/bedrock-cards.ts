/**
 * Amazon Bedrock model cards (issue #153). The user guide's "Models at a
 * glance" page links one card per model; each card states the API model id,
 * inference-profile ids, limits, modalities, lifecycle, and reasoning. A few
 * cards (OpenAI, xAI, Moonshot) also state token prices. A card with no
 * dollars is filled from the AWS price list, then the pricing page
 * (`bedrock-pricing.ts`). Every card is fetched as the `.md` twin AWS
 * publishes next to the HTML.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { TokenRateTier } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import { endpointIdFromPath } from '../ingest/bundle.ts'
import {
  cacheWriteLever,
  cacheWriteNamesDuration,
  bedrockNameKey,
  BEDROCK_PRICING_PAGE_URL,
  fetchBedrockPriceBook,
  lookupBedrockPrice,
} from './bedrock-pricing.ts'
import { tagDocsFacts } from './fact-sources.ts'
import {
  assertParsed,
  cachedDocs,
  mapConcurrent,
  markdownSection,
  markdownTableRows,
  tokenCount,
} from './model-facts.ts'
import type { ChatRequestMap } from './request-map.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo, ModelReasoning } from './types.ts'

const DOCS = 'https://docs.aws.amazon.com/bedrock/latest/userguide/'
/** docs.aws.amazon.com answers 403 without a User-Agent; workerd sends none. */
const DOCS_INIT = {
  headers: {
    'User-Agent': 'modelschemas (+https://modelschemas.openstory.workers.dev)',
  },
}
export const BEDROCK_CARDS_URL = `${DOCS}model-cards.md`
export const BEDROCK_CONVERSE_PATH = '/model/{modelId}/converse'

/** `anthropic.claude-sonnet-4-5-20250929-v1:0`, `us.openai.gpt-6-sol`. */
const MODEL_ID = /[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9.:-]*/g
/** AWS ends table lines with `| `; the shared reader wants a closing `|`. */
const tableRows = (text: string) =>
  markdownTableRows(text.replace(/[ \t]+$/gm, ''))

const YES = 'icon-yes.png'
const MONTHS = 'janfebmaraprmayjunjulaugsepoctnovdec'

/** Card slugs linked from the index, provider overview pages excluded. */
export function bedrockCardSlugs(index: string): Array<string> {
  const slugs = [...index.matchAll(/\]\((model-card-[a-z0-9.-]+)\.md\)/g)]
  return [...new Set(slugs.map((match) => match[1] ?? ''))]
}

function field(markdown: string, name: string): string | undefined {
  // GPT-6.1 Sol indents the bullet with two spaces; other cards use one.
  return markdown
    .match(new RegExp(`^\\+\\s+\\*\\*${name}:\\*\\*\\s+(.+)$`, 'm'))?.[1]
    ?.trim()
}

/** `Sep 30, 2025` / `September 30, 2025` → epoch seconds. */
function launchDay(text: string | undefined): number | null {
  const match = text?.match(/^([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})$/)
  const month = match?.[1] ? MONTHS.indexOf(match[1].toLowerCase()) / 3 : -1
  if (!match || !Number.isInteger(month) || month < 0) return null
  return Date.UTC(Number(match[3]), month, Number(match[2])) / 1000
}

/**
 * `Supported (…)` → the control the note names. A bare `Supported` states no
 * control, so reasoning stays null and only the capability flag is set.
 */
export function bedrockReasoning(
  text: string | undefined,
): ModelReasoning | null {
  const note = text?.match(/^Supported \((.+)\)$/)?.[1]
  if (!note) return null
  const efforts = note
    .match(/configurable\s*[—:]\s*([a-z, ]+)/)?.[1]
    ?.split(',')
    .map((effort) => effort.trim())
    .filter(Boolean)
  const cannotDisable =
    /cannot be disabled|cannot be turned off|thinking is always on/.test(note)
  const canDisable = /\bcan be (?:disabled|turned off)\b/.test(note)
  const mandatory = cannotDisable
    ? true
    : canDisable || efforts?.includes('none')
      ? false
      : null
  const named = efforts && efforts.length > 0 ? efforts : undefined
  // Adaptive cards name the levels after "configurable —". Keep the mode
  // and store those levels; a note with no list still has no efforts.
  if (/adaptive/.test(note)) {
    return {
      mode: 'adaptive',
      mandatory,
      ...(named ? { efforts: named } : {}),
    }
  }
  if (named) {
    return {
      mode: 'effort',
      mandatory,
      efforts: named,
    }
  }
  return null
}

const EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/**
 * A card whose Reasoning bullet is only `Supported` sometimes names the
 * levels under `**Reasoning effort**`. Adaptive notes with no level list
 * stay as the bullet parsed them.
 */
function reasoningEffortProse(markdown: string): ModelReasoning | null {
  const prose = markdown.replace(/```[\s\S]*?```/g, '')
  const honored: ModelReasoning | null =
    /^\+\s+\*\*Reasoning mode\*\*\s+[—-]\s+Reasoning effort is honored on both the Chat Completions and Responses APIs\b/m.test(
      prose,
    )
      ? { mode: 'effort', mandatory: null }
      : null
  const block = prose.match(
    /\*\*Reasoning effort\*\*([\s\S]*?)(?:\n\*\*|\n## |\n### |$)/,
  )?.[1]
  if (!block) return honored
  const declared = block.match(
    /(?:Set reasoning effort to|(?:You can )?configure effort through[^:]*:)\s*([^\n]+)/i,
  )?.[1]
  if (!declared) return honored
  const efforts: Array<string> = []
  for (const match of declared.matchAll(
    /`(?:\{[^`]*?"effort"\s*:\s*"([a-z]+)"[^`]*|"([a-z]+)"|([a-z]+))`/g,
  )) {
    const level = match[1] ?? match[2] ?? match[3]
    if (level && EFFORT_LEVELS.includes(level) && !efforts.includes(level)) {
      efforts.push(level)
    }
  }
  if (efforts.length < 2) return honored
  const cannot = /cannot be disabled|cannot be turned off/.test(block)
  const can = /\bcan be (?:disabled|turned off)\b|\(disables reasoning\)/.test(
    block,
  )
  return {
    mode: 'effort',
    mandatory: cannot ? true : efforts.includes('none') || can ? false : null,
    efforts,
  }
}

/**
 * Converse body from the Bedrock Runtime service model
 * (https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/bedrock-runtime/2023-09-30/service-2.json).
 * Roles are user, assistant, and system. There is no top-level
 * `reasoning_effort`; `outputConfig.effort` is a different shared field
 * and is not copied onto every model. `maxTokens` sits on
 * `inferenceConfig`, not `max_tokens`.
 */
const CONVERSE_REQUEST_MAP: ChatRequestMap = {
  thinking: null,
  maxTokensField: null,
  developerRole: false,
  replayReasoningContent: null,
  store: null,
  strictTools: null,
  sessionAffinity: null,
  cacheControl: null,
  toolStream: null,
  reasoningEffort: false,
}

/** Ticked feature labels state capabilities; a reasoning tick names no control. */
function cardFlags(
  markdown: string,
  reasoningOn: boolean,
): Array<string> | null {
  const flags: Array<string> = []
  if (reasoningOn) flags.push('reasoning')
  const seen = new Set<string>(flags)
  const parts = markdown.split(/icon-(yes|no)\.png/i)
  for (let index = 1; index < parts.length; index += 2) {
    if (parts[index]?.toLowerCase() !== 'yes') continue
    const label = (parts[index + 1] ?? '').split(/<br|\n|icon-/i)[0] ?? ''
    if (/\[Reasoning\]/i.test(label) && !seen.has('reasoning')) {
      seen.add('reasoning')
      flags.push('reasoning')
    }
    if (/client-side tool calling/i.test(label) && !seen.has('tools')) {
      seen.add('tools')
      flags.push('tools')
    }
    if (/structured outputs?/i.test(label) && !seen.has('structured_outputs')) {
      seen.add('structured_outputs')
      flags.push('structured_outputs')
    }
  }
  return flags.length > 0 ? flags : null
}

interface CardTables {
  input: Array<string>
  output: Array<string>
  converse: boolean
}

/** Labels with a green tick in one table cell. */
function ticked(cell: string | undefined): Array<string> {
  if (!cell?.includes(YES)) return []
  const label = cell.slice(cell.lastIndexOf(')') + 1).trim()
  return label ? [label] : []
}

function modalityName(label: string): string {
  const name = label.toLowerCase()
  return name === 'speech' ? 'audio' : name
}

function cardTables(rows: Array<Array<string>>): CardTables {
  const input = new Set<string>()
  const output = new Set<string>()
  let converse = false
  const head = rows.findIndex((row) =>
    /^\*\*input modalities\*\*$/i.test(row[0] ?? ''),
  )
  const width = rows[head]?.length
  for (const row of rows.slice(head + 1)) {
    if (head < 0 || row.length !== width || row[0]?.startsWith('**')) break
    for (const label of ticked(row[0])) input.add(modalityName(label))
    for (const label of ticked(row[1])) output.add(modalityName(label))
    // Newer cards list APIs in the third column of the same table.
    if (ticked(row[2]).includes('Converse')) converse = true
  }
  // Older cards: an API table per endpoint; the first is bedrock-runtime.
  const apis = rows.findIndex((row) => row.includes('**Converse**'))
  const column = rows[apis]?.indexOf('**Converse**') ?? -1
  if (rows[apis + 1]?.[column]?.includes(YES)) converse = true
  return { input: [...input], output: [...output], converse }
}

function activityOf(output: Array<string>): Activity | null {
  if (output.includes('text')) return 'chat'
  if (output.includes('embedding')) return 'embeddings'
  for (const activity of ['image', 'video', 'audio'] as const) {
    if (output.includes(activity)) return activity
  }
  return null
}

interface Quote {
  label: string
  rates: Record<string, number>
}

/**
 * A bare "cache write" column takes the one TTL the card names. GPT-6
 * headers omit the duration; the prompt-caching section says `ttl` `30m`
 * is the only one. No TTL mentioned keeps the 5-minute lever. Two
 * different TTLs have no single lever.
 */
function proseWriteLever(markdown: string): string | null {
  const found = new Set<'5m' | '1h' | 'other'>()
  const ttls = /ttl\b[^.\n]{0,80}?(\d+)\s*(m|h|min(?:ute)?s?|hours?)\b/gi
  for (const match of markdown.matchAll(ttls)) {
    const n = match[1]
    const unit = match[2]?.toLowerCase()
    if (!n || !unit) continue
    if (n === '5' && unit.startsWith('m')) found.add('5m')
    else if (n === '1' && unit.startsWith('h')) found.add('1h')
    else found.add('other')
  }
  if (found.size === 0) return 'cache_write_tokens'
  if (found.size > 1) return null
  if (found.has('5m')) return 'cache_write_tokens'
  if (found.has('1h')) return 'cache_write_1h_tokens'
  return null
}

function lever(header: string, markdown: string): string | null {
  const name = header.replace(/\*/g, '').toLowerCase()
  if (name.includes('cache read')) return 'cache_read_tokens'
  if (name.includes('cache write')) {
    if (cacheWriteNamesDuration(name)) return cacheWriteLever(name)
    return proseWriteLever(markdown)
  }
  if (name === 'input') return 'input_tokens'
  if (name === 'output') return 'output_tokens'
  return null
}

/** Rows of a `| **Inference option** | **Input** | … |` table. */
function quotes(block: string, markdown: string): Array<Quote> {
  const rows = tableRows(block)
  const head = rows.find((row) => row[0] === '**Inference option**')
  if (!head) return []
  const out: Array<Quote> = []
  for (const row of rows) {
    if (row === head) continue
    const rates: Record<string, number> = {}
    row.forEach((cell, index) => {
      const key = lever(head[index] ?? '', markdown)
      const dollars = cell.match(/^\$(\d+(?:\.\d+)?)$/)?.[1]
      if (key && cell.includes('$') && dollars === undefined) {
        throw new Error('amazon-bedrock model card pricing: unreadable quote')
      }
      if (key && dollars) rates[key] = Number(dollars) / 1e6
    })
    if (
      row.some((cell) => cell.includes('$')) &&
      (!('input_tokens' in rates) || !('output_tokens' in rates))
    ) {
      throw new Error('amazon-bedrock model card pricing: unreadable quote')
    }
    if ('input_tokens' in rates && 'output_tokens' in rates) {
      out.push({ label: row[0] ?? '', rates })
    }
  }
  return out
}

/** Ultrafast, priority, flex, batch, and GovCloud are not the standard rate. */
function skippedPriceHeading(heading: string): boolean {
  return /ultrafast|priority|flex|batch|govcloud/i.test(heading)
}

function standardShort(heading: string): boolean {
  return /commercial regions/i.test(heading) && /short context/i.test(heading)
}

const inRegion = (all: Array<Quote>) =>
  all.find((quote) => /in-region|regional/i.test(quote.label))

const sameRates = (a: Quote, b: Quote) =>
  JSON.stringify(Object.entries(a.rates).sort()) ===
  JSON.stringify(Object.entries(b.rates).sort())

export interface BedrockCardPrice {
  base: Record<string, number>
  tiers: Array<TokenRateTier>
  /** Every published inference option bills the in-Region rate. */
  uniform: boolean
}

/**
 * Standard-tier commercial price of the base model id: the in-Region row.
 * Null when the card names no dollar amount, quotes a unit other than one
 * million tokens, or prices only cross-Region profiles — those bill a
 * different rate than the id this row is keyed on.
 */
export function bedrockCardPrice(
  markdown: string,
  scope: 'regional' | 'global' = 'regional',
): BedrockCardPrice | null {
  const full = markdownSection(markdown, 'Pricing')
  if (!/per 1 million tokens/.test(full)) return null
  // GovCloud (US) republishes the same table at a different rate. The
  // commercial block is the standard price; a GovCloud-only card stays.
  const beforeGov = full.split('**AWS GovCloud')[0] ?? full
  const section = quotes(beforeGov, markdown).length > 0 ? beforeGov : full
  const blocks = section.split(/\n### /)
  let baseBlock: string | undefined
  for (const [index, block] of blocks.entries()) {
    if (quotes(block, markdown).length === 0) continue
    const heading = block.split('\n')[0] ?? ''
    if (skippedPriceHeading(heading)) continue
    // A headingless table (Grok) is already the commercial rate. A ###
    // block has to be the standard short-context rate; Ultrafast uses
    // the same "Commercial Regions, short context" words.
    if (index > 0 && !standardShort(heading)) return null
    baseBlock = block
    break
  }
  if (baseBlock === undefined) return null
  const baseQuotes = quotes(baseBlock, markdown)
  const pick = (items: Array<Quote>) =>
    scope === 'global'
      ? items.find((quote) => /global/i.test(quote.label))
      : inRegion(items)
  const base = pick(baseQuotes)
  if (!base) return null
  let uniform = baseQuotes.every((quote) => sameRates(quote, base))
  const tiers: Array<TokenRateTier> = []
  for (const block of blocks) {
    const heading = block.split('\n')[0] ?? ''
    // GovCloud's long-context table is a #### inside the ### GovCloud
    // block. Match the ### line only, or that table becomes the tier.
    if (skippedPriceHeading(heading)) continue
    const over = heading.match(
      /long context \(more than ([\d.,]+\s*[KM]?) input tokens\)/i,
    )
    if (!over?.[1]) continue
    const longQuotes = quotes(block, markdown)
    const long = pick(longQuotes)
    const minPromptTokens = tokenCount(over[1])
    // A long-context table we cannot read would underprice long prompts.
    if (!long || minPromptTokens === null) {
      throw new Error(
        'amazon-bedrock model card pricing: unreadable long-context tier',
      )
    }
    uniform &&= longQuotes.every((quote) => sameRates(quote, long))
    tiers.push({ minPromptTokens, rates: long.rates })
  }
  return { base: base.rates, tiers, uniform }
}

/** Profiles explicitly named by the provider's own programmatic-access table. */
export function parseBedrockProfileRows(
  markdown: string,
  source: { url: string; hash: string; extractedAt: string },
): Array<ModelInfo> {
  const base = parseBedrockCard(markdown, source)
  if (!base) return []
  const ids = new Set(
    tableRows(markdown)
      .filter(
        (row) =>
          row.length === 5 && /^bedrock-(runtime|mantle)$/.test(row[0] ?? ''),
      )
      .flatMap((row) => [
        ...(row[3]?.match(MODEL_ID) ?? []),
        ...(row[4]?.match(MODEL_ID) ?? []),
      ]),
  )
  return [...ids]
    .filter((id) => id !== base.rawId)
    .map((rawId) => {
      const quote = rawId.startsWith('global.')
        ? bedrockCardPrice(markdown, 'global')
        : null
      const pricing = quote
        ? compileTokenCard(quote.base, quote.tiers, source)
        : null
      // Geo ids do not identify the billed AWS region. A US-region quote
      // cannot be assigned to an EU profile. Preserve other explicitly sourced
      // model facts, but never inherit the base model's price or aliases.
      const sources = { ...base.factSources }
      delete sources.pricing
      return {
        ...base,
        rawId,
        aliases: [],
        pricing,
        absent: pricing ? {} : { pricing: 'cleared' },
        factSources: {
          ...sources,
          ...(pricing
            ? tagDocsFacts({ pricing }, source.url, source.hash)
            : {}),
        },
      }
    })
}

/** One card → a catalog row, or null when it states no model id. */
export function parseBedrockCard(
  markdown: string,
  source: { url: string; hash: string; extractedAt: string },
): ModelInfo | null {
  const rows = tableRows(markdown)
  const access = rows.filter(
    (row) =>
      row.length === 5 && /^bedrock-(runtime|mantle)$/.test(row[0] ?? ''),
  )
  const baseIds = access.flatMap((row) => row[1]?.match(MODEL_ID) ?? [])
  const rawId = baseIds[0]
  if (!rawId) return null
  const price = bedrockCardPrice(markdown)
  // Profile ids are distinct rows, even when today's rates happen to agree.
  const aliases = [...new Set(baseIds)].filter((id) => id !== rawId)

  const tables = cardTables(rows)
  const activity = activityOf(tables.output)
  const reasoningText = field(markdown, 'Reasoning')
  const reasoning =
    bedrockReasoning(reasoningText) ?? reasoningEffortProse(markdown)
  const converse = activity === 'chat' && tables.converse
  const info: ModelInfo = {
    rawId,
    displayName: markdown.match(/^# (.+)$/m)?.[1]?.trim() ?? null,
    activity,
    contextWindow: tokenCount(field(markdown, 'Context window')),
    maxOutput: tokenCount(field(markdown, 'Max output tokens')),
    modalities:
      tables.input.length > 0 || tables.output.length > 0
        ? { input: tables.input, output: tables.output }
        : null,
    pricing: price ? compileTokenCard(price.base, price.tiers, source) : null,
    capabilities: cardFlags(
      markdown,
      reasoningText?.startsWith('Supported') === true || reasoning != null,
    ),
    reasoning,
    requestMap: converse ? CONVERSE_REQUEST_MAP : null,
    schemaEndpointId: converse
      ? endpointIdFromPath(BEDROCK_CONVERSE_PATH)
      : null,
    aliases,
    deprecated: field(markdown, 'Model lifecycle') === 'Legacy',
    releasedAt: launchDay(field(markdown, 'Model launch date')),
  }
  info.factSources = tagDocsFacts(info, source.url, source.hash)
  return info
}

export async function bedrockCardModels(
  kv?: KVNamespace,
): Promise<Array<ModelInfo>> {
  const doc = await cachedDocs(kv, BEDROCK_CARDS_URL, async () => {
    const slugs = bedrockCardSlugs(
      await fetchText(BEDROCK_CARDS_URL, DOCS_INIT),
    )
    // ponytail: one fetch per card (~135) on a six-hourly cache miss, out of
    // the poll invocation's shared 1,000 subrequests. Move Bedrock to its own
    // cron if the poll starts exhausting the budget.
    const parsed = await mapConcurrent(slugs, 6, async (slug) => {
      const url = `${DOCS}${slug}.md`
      const markdown = await fetchText(url, DOCS_INIT)
      const source = {
        url,
        hash: await sha256Text(markdown),
        extractedAt: new Date().toISOString(),
      }
      return {
        model: parseBedrockCard(markdown, source),
        profiles: parseBedrockProfileRows(markdown, source),
      }
    })
    const byId = new Map<string, ModelInfo>()
    const profileById = new Map<string, ModelInfo>()
    for (const { model, profiles } of parsed) {
      for (const profile of profiles) {
        if (!profileById.has(profile.rawId))
          profileById.set(profile.rawId, profile)
      }
      if (model && !byId.has(model.rawId)) byId.set(model.rawId, model)
    }
    assertParsed(byId, 'amazon-bedrock model cards')
    // The poll marks unlisted rows removed. A card layout change that drops
    // most ids must fail the poll, not shrink the catalog.
    if (byId.size < slugs.length * 0.8) {
      throw new Error(
        `amazon-bedrock model cards: ${String(byId.size)} of ${String(slugs.length)} cards state a model id`,
      )
    }
    const models: Array<ModelInfo> = [...byId.values()].map((model) => ({
      ...model,
      aliases: (model.aliases ?? []).filter((id) => !byId.has(id)),
    }))
    const book = await fetchBedrockPriceBook()
    for (const model of models) {
      if (model.pricing != null) continue
      const hit = lookupBedrockPrice(
        book,
        model.rawId,
        model.displayName ?? null,
      )
      if (!hit) continue
      const pricing = compileTokenCard(hit.rates, [], {
        url: hit.url,
        hash: hit.hash,
        extractedAt: new Date().toISOString(),
      })
      if (!pricing) continue
      model.pricing = pricing
      model.factSources = {
        ...model.factSources,
        ...tagDocsFacts({ pricing }, hit.url, hit.hash),
      }
    }
    for (const profile of profileById.values()) {
      if (byId.has(profile.rawId)) continue
      if (profile.pricing == null && profile.rawId.startsWith('global.')) {
        const rates = book.globalPageByName?.get(
          bedrockNameKey(profile.displayName ?? ''),
        )
        if (rates) {
          const pricing = compileTokenCard(rates, [], {
            url: BEDROCK_PRICING_PAGE_URL,
            hash: book.pageHash,
            extractedAt: new Date().toISOString(),
          })
          if (pricing) {
            profile.pricing = pricing
            profile.absent = {}
            profile.factSources = {
              ...profile.factSources,
              ...tagDocsFacts(
                { pricing },
                BEDROCK_PRICING_PAGE_URL,
                book.pageHash,
              ),
            }
          }
        }
      }
      models.push(profile)
    }
    return { models }
  })
  return doc.models
}
