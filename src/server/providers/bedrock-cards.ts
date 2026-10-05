/**
 * Amazon Bedrock model cards (issue #153). The user guide's "Models at a
 * glance" page links one card per model; each card states the API model id,
 * inference-profile ids, limits, modalities, lifecycle, and reasoning. A few
 * cards (OpenAI, xAI, Moonshot) also state token prices; the rest point at
 * the marketing pricing page, which is not parsed, so those prices stay null.
 * Every page is fetched as the `.md` twin AWS publishes next to the HTML.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { TokenRateTier } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import { endpointIdFromPath } from '../ingest/bundle.ts'
import {
  assertParsed,
  cachedDocs,
  mapConcurrent,
  markdownSection,
  markdownTableRows,
  tokenCount,
} from './model-facts.ts'
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
  return markdown
    .match(new RegExp(`^\\+ \\*\\*${name}:\\*\\* (.+)$`, 'm'))?.[1]
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
  const canDisable = /can be disabled|turned off/.test(note)
  if (efforts && efforts.length > 0) {
    return {
      mode: 'effort',
      mandatory: !canDisable && !efforts.includes('none'),
      efforts,
    }
  }
  if (!/adaptive/.test(note)) return null
  return { mode: 'adaptive', mandatory: /cannot be disabled/.test(note) }
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

function lever(header: string): string | null {
  const name = header.replace(/\*/g, '').toLowerCase()
  if (name.includes('cache read')) return 'cache_read_tokens'
  if (name.includes('cache write')) return 'cache_write_tokens'
  if (name === 'input') return 'input_tokens'
  if (name === 'output') return 'output_tokens'
  return null
}

/** Rows of a `| **Inference option** | **Input** | … |` table. */
function quotes(block: string): Array<Quote> {
  const rows = tableRows(block)
  const head = rows.find((row) => row[0] === '**Inference option**')
  if (!head) return []
  const out: Array<Quote> = []
  for (const row of rows) {
    if (row === head) continue
    const rates: Record<string, number> = {}
    row.forEach((cell, index) => {
      const key = lever(head[index] ?? '')
      const dollars = cell.match(/^\$(\d+(?:\.\d+)?)$/)?.[1]
      if (key && dollars) rates[key] = Number(dollars) / 1e6
    })
    if ('input_tokens' in rates && 'output_tokens' in rates) {
      out.push({ label: row[0] ?? '', rates })
    }
  }
  return out
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
export function bedrockCardPrice(markdown: string): BedrockCardPrice | null {
  const section = markdownSection(markdown, 'Pricing')
  if (!/per 1 million tokens/.test(section)) return null
  const blocks = section.split(/\n### /)
  const priced = blocks.findIndex((block) => quotes(block).length > 0)
  const first = blocks[priced]
  if (first === undefined) return null
  if (priced > 0 && !first.startsWith('Commercial Regions — short context')) {
    return null
  }
  const baseQuotes = quotes(first)
  const base = inRegion(baseQuotes)
  if (!base) return null
  let uniform = baseQuotes.every((quote) => sameRates(quote, base))
  const tiers: Array<TokenRateTier> = []
  for (const block of blocks) {
    const over = block.match(
      /^Commercial Regions — long context \(more than ([\d.,]+[KM]?) input tokens\)/,
    )
    if (!over) continue
    const longQuotes = quotes(block)
    const long = inRegion(longQuotes)
    const minPromptTokens = tokenCount(over[1])
    // A long-context table we cannot read would underprice long prompts.
    if (!long || minPromptTokens === null) return null
    uniform &&= longQuotes.every((quote) => sameRates(quote, long))
    tiers.push({ minPromptTokens, rates: long.rates })
  }
  return { base: base.rates, tiers, uniform }
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
  const profileIds = access.flatMap((row) => [
    ...(row[3]?.match(MODEL_ID) ?? []),
    ...(row[4]?.match(MODEL_ID) ?? []),
  ])
  const price = bedrockCardPrice(markdown)
  // A profile id that bills a different rate must not resolve to this card.
  const aliases = [
    ...new Set([...baseIds, ...(price && !price.uniform ? [] : profileIds)]),
  ].filter((id) => id !== rawId)

  const tables = cardTables(rows)
  const activity = activityOf(tables.output)
  const reasoning = field(markdown, 'Reasoning')
  return {
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
    capabilities: reasoning?.startsWith('Supported') ? ['reasoning'] : null,
    reasoning: bedrockReasoning(reasoning),
    schemaEndpointId:
      activity === 'chat' && tables.converse
        ? endpointIdFromPath(BEDROCK_CONVERSE_PATH)
        : null,
    aliases,
    deprecated: field(markdown, 'Model lifecycle') === 'Legacy',
    releasedAt: launchDay(field(markdown, 'Model launch date')),
  }
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
      return parseBedrockCard(markdown, {
        url,
        hash: await sha256Text(markdown),
        extractedAt: new Date().toISOString(),
      })
    })
    const byId = new Map<string, ModelInfo>()
    for (const model of parsed) {
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
    const models = [...byId.values()].map((model) => ({
      ...model,
      aliases: (model.aliases ?? []).filter((id) => !byId.has(id)),
    }))
    return { models }
  })
  return doc.models
}
