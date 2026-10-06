/**
 * MiniMax chat facts from platform.minimax.io. The Anthropic SDK page has
 * the context-window, thinking, and content-type tables. The chat spec
 * states the output cap. The pay-as-you-go page has the token prices, USD
 * per 1M tokens. A parse that finds no rows throws.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { TokenRateTier } from '@modelschemas/rate-card'

import { tagDocsFacts } from './fact-sources.ts'
import {
  assertParsed,
  cachedDocs,
  markdownSection,
  markdownTableRows,
  tokenCount,
} from './model-facts.ts'
import type { ModelFacts } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelReasoning } from './types.ts'

const DOCS = 'https://platform.minimax.io/docs'
export const MINIMAX_SDK_URL = `${DOCS}/api-reference/text-anthropic-api.md`
export const MINIMAX_PRICING_URL = `${DOCS}/guides/pricing-paygo.md`
export const MINIMAX_CHAT_SPEC_URL = `${DOCS}/api-reference/text/api/openapi-chat-openai.json`
export const MINIMAX_MESSAGES_SPEC_URL = `${DOCS}/api-reference/text/api/openapi-chat-anthropic.json`

const ID_PREFIX = 'MiniMax-'

/** `MiniMax-M3` must not match inside `MiniMax-M3.1-Flash-Preview`. */
function names(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-]|\\.\\w)`).test(text)
}

/** The `Model Name | Context Window` table. */
export function parseMinimaxContextWindows(
  markdown: string,
): Map<string, number> {
  const out = new Map<string, number>()
  let column = -1
  for (const cells of markdownTableRows(markdown)) {
    const header = cells.indexOf('Context Window')
    if (header >= 0) {
      column = header
      continue
    }
    const id = (cells[0] ?? '').replace(/<[^>]+>/g, '').trim()
    const window = cells[column] ?? ''
    if (!id.startsWith(ID_PREFIX) || !/^[\d,]+$/.test(window)) continue
    const tokens = tokenCount(window)
    if (tokens !== null) out.set(id, tokens)
  }
  return out
}

const INPUT_TYPES = new Set(['text', 'image', 'video', 'audio'])

/**
 * The `Messages Field Support` table. A `type="image"` row is every model
 * when its status is `Fully supported`, and otherwise only the models the
 * status names (`M3.1-Flash-Preview / M3 only`).
 */
export function parseMinimaxInputModalities(
  markdown: string,
  ids: Array<string>,
): Map<string, Array<string>> {
  const out = new Map<string, Array<string>>()
  for (const cells of markdownTableRows(markdown)) {
    const type = cells[0]?.match(/^`type="(\w+)"`$/)?.[1]
    const status = cells[1] ?? ''
    if (!type || !INPUT_TYPES.has(type)) continue
    const named = /^fully supported$/i.test(status)
      ? ids
      : [...status.matchAll(/\bM\d[\w.-]*/g)].map(
          (match) => `${ID_PREFIX}${match[0]}`,
        )
    for (const id of named) {
      if (!ids.includes(id)) continue
      out.set(id, [...(out.get(id) ?? []), type])
    }
  }
  return out
}

/**
 * The `Thinking Control` table: every model takes `thinking.type: adaptive`,
 * and the `disabled` column says whether thinking can be turned off. A
 * `M2.x` row covers the listed `MiniMax-M2…` ids that have no row of their
 * own. Effort names come from the `output_config.effort` parameter row,
 * for the models that row names.
 */
export function parseMinimaxReasoning(
  markdown: string,
  ids: Array<string>,
): Map<string, ModelReasoning> {
  const out = new Map<string, ModelReasoning>()
  const families: Array<[string, ModelReasoning]> = []
  const rows = markdownTableRows(markdown)
  let adaptive = -1
  let disabled = -1
  for (const cells of rows) {
    if (cells.includes('`{"type": "disabled"}`')) {
      adaptive = cells.indexOf('`{"type": "adaptive"}`')
      disabled = cells.indexOf('`{"type": "disabled"}`')
      continue
    }
    if (adaptive < 0 || !/^thinking on$/i.test(cells[adaptive] ?? '')) continue
    const off = cells[disabled] ?? ''
    const mandatory = /cannot be disabled|remains on/i.test(off)
    if (!mandatory && !/\boff\b/i.test(off)) continue
    const reasoning: ModelReasoning = { mode: 'adaptive', mandatory }
    const model = cells[0] ?? ''
    const id = model.match(/^`([^`]+)`$/)?.[1]
    const family = model.match(/^(M\d+)\.x$/)?.[1]
    if (id && ids.includes(id)) out.set(id, reasoning)
    else if (family) families.push([`${ID_PREFIX}${family}`, reasoning])
  }
  for (const [prefix, reasoning] of families) {
    for (const id of ids) {
      const rest = id.startsWith(prefix) ? id.slice(prefix.length) : null
      if (rest === null || out.has(id)) continue
      if (rest === '' || /^[.-]/.test(rest)) out.set(id, reasoning)
    }
  }
  const effort = rows.find((cells) => cells[0] === '`output_config.effort`')
  const description = effort?.[2] ?? ''
  const efforts = [
    ...(description.match(/Accepts ([^;.]+)/)?.[1] ?? '').matchAll(
      /`([a-z]+)`/g,
    ),
  ].flatMap((match) => (match[1] ? [match[1]] : []))
  if (efforts.length > 0) {
    for (const [id, reasoning] of out) {
      if (names(description, id)) out.set(id, { ...reasoning, efforts })
    }
  }
  return out
}

/**
 * The spec's `max_completion_tokens` description: `For A and B … the
 * maximum is N; for other models … the maximum is M`.
 */
export function parseMinimaxMaxOutput(
  description: string,
  ids: Array<string>,
): Map<string, number> {
  const out = new Map<string, number>()
  let others: number | null = null
  for (const clause of description.split(/;|\.\s/)) {
    const max = clause.match(/the maximum is ([\d,]+)/i)?.[1]
    const tokens = max ? tokenCount(max) : null
    if (tokens === null) continue
    const named = ids.filter((id) => names(clause, id))
    for (const id of named) out.set(id, tokens)
    if (named.length === 0 && /other models/i.test(clause)) others = tokens
  }
  if (others !== null) {
    for (const id of ids) if (!out.has(id)) out.set(id, others)
  }
  return out
}

function maxCompletionTokensDescription(spec: unknown): string {
  let found = ''
  const walk = (node: unknown) => {
    if (found || typeof node !== 'object' || node === null) return
    const cap = (node as Record<string, unknown>).max_completion_tokens
    const description =
      typeof cap === 'object' && cap !== null
        ? (cap as Record<string, unknown>).description
        : undefined
    if (typeof description === 'string') found = description
    else for (const value of Object.values(node)) walk(value)
  }
  walk(spec)
  return found
}

const PRICE_LEVERS: Record<string, string> = {
  Input: 'input_tokens',
  Output: 'output_tokens',
  'Prompt caching Read': 'cache_read_tokens',
  'Prompt caching Write': 'cache_write_tokens',
}

/** `~~\$0.60~~ \$0.30 / M tokens` → 0.30: the struck list price is not billed. */
function perMillion(cell: string): number | null {
  const billed = cell.replace(/~~[^~]*~~/g, '').trim()
  const amount = billed.match(/^\\?\$([\d.]+) \/ M tokens$/)?.[1]
  return amount ? Number(amount) : null
}

export interface MinimaxRates {
  base: Record<string, number>
  tiers: Array<TokenRateTier>
}

/**
 * The `## LLM` tables, standard tier only: the `Priority` tab is dropped.
 * A `> 512k input tokens` row is a tier over the same model's base row.
 * Rates are USD per token.
 */
export function parseMinimaxPricing(
  markdown: string,
): Map<string, MinimaxRates> {
  const section = markdownSection(markdown, 'LLM')
    .replace(/<Tab title="(?!Standard")[^"]*">[\s\S]*?<\/Tab>/g, '')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
  const out = new Map<string, MinimaxRates>()
  let header: Array<string> = []
  for (const cells of markdownTableRows(section)) {
    if (cells[0] === 'Model') {
      header = cells
      continue
    }
    const model = cells[0]?.match(/^\*\*([A-Za-z0-9][\w.-]*)\*\*(.*)$/)
    const id = model?.[1]
    if (!id || cells.length !== header.length) continue
    const rates: Record<string, number> = {}
    header.forEach((name, index) => {
      const lever = PRICE_LEVERS[name]
      const amount = lever ? perMillion(cells[index] ?? '') : null
      if (lever && amount !== null) rates[lever] = amount / 1e6
    })
    if (rates.input_tokens === undefined || rates.output_tokens === undefined) {
      continue
    }
    const entry = out.get(id) ?? { base: {}, tiers: [] }
    const bound = model[2]?.match(/([≤>])\s*([\d.]+[kKmM]?) input tokens/)
    const above = bound?.[1] === '>' ? tokenCount(bound[2]) : null
    if (above !== null) entry.tiers.push({ minPromptTokens: above, rates })
    else entry.base = rates
    out.set(id, entry)
  }
  return out
}

/** Facts for one chat id; `{}` when the docs do not name it. */
export async function minimaxModelFacts(
  kv?: KVNamespace,
): Promise<(rawId: string) => Partial<ModelFacts>> {
  const doc = await cachedDocs(kv, MINIMAX_SDK_URL, async () => {
    const [sdk, pricingPage, specText] = await Promise.all([
      fetchText(MINIMAX_SDK_URL),
      fetchText(MINIMAX_PRICING_URL),
      fetchText(MINIMAX_CHAT_SPEC_URL),
    ])
    const windows = parseMinimaxContextWindows(sdk)
    assertParsed(windows, 'minimax context windows')
    const ids = [...windows.keys()]
    const inputs = parseMinimaxInputModalities(sdk, ids)
    assertParsed(inputs, 'minimax input modalities')
    const reasoning = parseMinimaxReasoning(sdk, ids)
    assertParsed(reasoning, 'minimax thinking table')
    const caps = parseMinimaxMaxOutput(
      maxCompletionTokensDescription(JSON.parse(specText) as unknown),
      ids,
    )
    assertParsed(caps, 'minimax max output')
    const prices = parseMinimaxPricing(pricingPage)
    assertParsed(prices, 'minimax pricing page')

    const [sdkHash, pricingHash, specHash] = await Promise.all([
      sha256Text(sdk),
      sha256Text(pricingPage),
      sha256Text(specText),
    ])
    const extractedAt = new Date().toISOString()
    const facts: Record<string, Partial<ModelFacts>> = {}
    for (const id of ids) {
      const input = inputs.get(id)
      const fromSdk = {
        contextWindow: windows.get(id) ?? null,
        modalities: input ? { input, output: ['text'] } : null,
        reasoning: reasoning.get(id) ?? null,
      }
      const maxOutput = caps.get(id) ?? null
      const rates = prices.get(id)
      const pricing = rates
        ? compileTokenCard(rates.base, rates.tiers, {
            url: MINIMAX_PRICING_URL,
            hash: pricingHash,
            extractedAt,
          })
        : null
      facts[id] = {
        ...fromSdk,
        maxOutput,
        pricing,
        factSources: {
          ...tagDocsFacts(fromSdk, MINIMAX_SDK_URL, sdkHash),
          ...tagDocsFacts({ maxOutput }, MINIMAX_CHAT_SPEC_URL, specHash),
          ...tagDocsFacts({ pricing }, MINIMAX_PRICING_URL, pricingHash),
        },
      }
    }
    return { facts }
  })
  return (rawId) => doc.facts[rawId] ?? {}
}
