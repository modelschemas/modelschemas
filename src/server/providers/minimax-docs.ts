/**
 * MiniMax chat facts from platform.minimax.io. The Anthropic SDK page has
 * the context-window, thinking, and content-type tables. The chat spec
 * states the output cap. The pay-as-you-go page has the token prices, USD
 * per 1M tokens. A parse that finds no rows throws.
 *
 * The China platform (platform.minimaxi.com) publishes the same pages in
 * Chinese: `MINIMAX_CN` holds its URLs and wording. Its prices are yuan
 * per 1M tokens, stored as CNY cards.
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
import { sha256Text } from './types.ts'
import type { ModelReasoning } from './types.ts'

const DOCS = 'https://platform.minimax.io/docs'
export const MINIMAX_SDK_URL = `${DOCS}/api-reference/text-anthropic-api.md`
export const MINIMAX_PRICING_URL = `${DOCS}/guides/pricing-paygo.md`
export const MINIMAX_CHAT_SPEC_URL = `${DOCS}/api-reference/text/api/openapi-chat-openai.json`
export const MINIMAX_MESSAGES_SPEC_URL = `${DOCS}/api-reference/text/api/openapi-chat-anthropic.json`

const ID_PREFIX = 'MiniMax-'

/** One platform's page URLs and the wording its tables and spec use. */
export interface MinimaxPlatform {
  /** Names the platform in a zero-row parse error. */
  label: string
  /** Hosts allowed to answer a page fetch, redirects included. */
  hosts: Array<string>
  sdkUrl: string
  chatSpecUrl: string
  pricingUrl: string
  /** ISO-4217 code of the pricing page's amounts; absent for USD. */
  currency?: string
  /** `## <heading>` of the token-price tables. */
  priceSection: string
  /** Title of the standard-tier `<Tab>`; every other tab is dropped. */
  standardTab: string
  /**
   * Title of the only `<Accordion>` whose rows are standard prices. One
   * with any other title is ignored when it holds no price row, and
   * refuses the section when it does.
   */
  legacyAccordion: string
  /** First header cell of a price table. */
  modelHeader: string
  /** Price-table header cell → the usage lever it prices. */
  priceLevers: Record<string, string>
  /** A billed price cell, whole: group 1 is the amount per 1M tokens. */
  price: RegExp
  /** The badge that makes a struck price the standing one. */
  permanent: RegExp
  /** A model cell's tier bound: group 1 is `≤` or `>`, group 2 the count. */
  inputBound: RegExp
  /** Header of the context-window column. */
  contextWindow: string
  /** `Messages Field Support` status: every model. */
  allModels: RegExp
  /**
   * Status naming the only models that take the type: group 1 is the
   * `M3.1-Flash-Preview / M3` list and nothing else may follow it.
   */
  onlyModels: RegExp
  /** `Thinking Control` cells, each anchored to the end of the cell. */
  thinkingOn: RegExp
  cannotDisable: RegExp
  thinkingOff: RegExp
  /** Group 1 is the effort list in the `output_config.effort` row. */
  efforts: RegExp
  /** Splits the `max_completion_tokens` description into clauses. */
  clause: RegExp
  /** Group 1 is a clause's maximum, a plain token count. */
  maximum: RegExp
  otherModels: RegExp
}

export const MINIMAX: MinimaxPlatform = {
  label: 'minimax',
  hosts: ['platform.minimax.io'],
  sdkUrl: MINIMAX_SDK_URL,
  chatSpecUrl: MINIMAX_CHAT_SPEC_URL,
  pricingUrl: MINIMAX_PRICING_URL,
  priceSection: 'LLM',
  standardTab: 'Standard',
  legacyAccordion: 'Legacy Models',
  modelHeader: 'Model',
  priceLevers: {
    Input: 'input_tokens',
    Output: 'output_tokens',
    'Prompt caching Read': 'cache_read_tokens',
    'Prompt caching Write': 'cache_write_tokens',
  },
  price: /^\\?\$([\d.]+) \/ M tokens$/,
  permanent: /<span[^>]*>\s*Permanent\b/,
  inputBound: /([≤>])\s*([\d.]+[kKmM]?) input tokens/,
  contextWindow: 'Context Window',
  allModels: /^fully supported$/i,
  onlyModels: /^(M\d[\w.-]*(?:\s*\/\s*M\d[\w.-]*)*) only$/i,
  thinkingOn: /^thinking on$/i,
  cannotDisable: /(?:^|[—;,] )thinking (?:cannot be disabled|remains on)$/i,
  thinkingOff: /^thinking stays off$/i,
  efforts: /Accepts ([^;.]+)/,
  clause: /;|\.\s/,
  maximum: /the maximum is ([\d,]+)/i,
  otherModels: /other models/i,
}

const DOCS_CN = 'https://platform.minimaxi.com/docs'
export const MINIMAX_CN_MESSAGES_SPEC_URL = `${DOCS_CN}/api-reference/text/api/openapi-chat-anthropic.json`

export const MINIMAX_CN: MinimaxPlatform = {
  label: 'minimax-cn',
  // platform.minimaxi.com answers 302 to the same path on platform.minimax.cn.
  hosts: ['platform.minimaxi.com', 'platform.minimax.cn'],
  sdkUrl: `${DOCS_CN}/api-reference/text-anthropic-api.md`,
  chatSpecUrl: `${DOCS_CN}/api-reference/text/api/openapi-chat-openai.json`,
  pricingUrl: `${DOCS_CN}/guides/pricing-paygo.md`,
  currency: 'CNY',
  priceSection: '语言模型',
  standardTab: '标准',
  legacyAccordion: '历史模型',
  modelHeader: '**模型**',
  // The header carries the unit, so a reworded unit prices nothing.
  priceLevers: {
    '**输入价格**<br /> 元/百万 tokens': 'input_tokens',
    '**输出价格**<br /> 元/百万 tokens': 'output_tokens',
    '**缓存读取**<br /> 元/百万 tokens': 'cache_read_tokens',
    '**缓存写入**<br /> 元/百万 tokens': 'cache_write_tokens',
  },
  price: /^(\d+(?:\.\d+)?)$/,
  permanent: /<span[^>]*>\s*永久/,
  inputBound: /([≤>])\s*([\d.]+[kKmM]?) 输入 tokens/,
  contextWindow: '上下文窗口',
  allModels: /^完全支持$/,
  onlyModels: /^仅\s*(M\d[\w.-]*(?:\s*\/\s*M\d[\w.-]*)*)$/,
  thinkingOn: /^开启 thinking$/,
  cannotDisable: /(?:^|，)thinking (?:无法关闭|仍保持开启)$/,
  thinkingOff: /^保持 thinking 关闭$/,
  efforts: /可取([^；。]+)/,
  clause: /；|。/,
  // `推荐值上限为` is a cap on the recommended value, not on output.
  maximum: /(?<!推荐值)上限为\s*([\d,]+)/,
  otherModels: /其他模型/,
}

/** `MiniMax-M3` must not match inside `MiniMax-M3.1-Flash-Preview`. */
function names(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-]|\\.\\w)`).test(text)
}

/** The `Model Name | Context Window` table. */
export function parseMinimaxContextWindows(
  markdown: string,
  platform: MinimaxPlatform = MINIMAX,
): Map<string, number> {
  const out = new Map<string, number>()
  let column = -1
  for (const cells of markdownTableRows(markdown)) {
    const header = cells.indexOf(platform.contextWindow)
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
 * status names (`M3.1-Flash-Preview / M3 only`). Empty when a status reads
 * as neither or names a model the page does not list, so a reworded row
 * (`M2.x not supported`) cannot move a type between models.
 */
export function parseMinimaxInputModalities(
  markdown: string,
  ids: Array<string>,
  platform: MinimaxPlatform = MINIMAX,
): Map<string, Array<string>> {
  const out = new Map<string, Array<string>>()
  for (const cells of markdownTableRows(markdown)) {
    const type = cells[0]?.match(/^`type="(\w+)"`$/)?.[1]
    const status = cells[1] ?? ''
    if (!type || !INPUT_TYPES.has(type)) continue
    const everyModel = platform.allModels.test(status)
    const only = status.match(platform.onlyModels)?.[1]
    if (!everyModel && only === undefined) return new Map()
    const named = everyModel
      ? ids
      : [...(only ?? '').matchAll(/\bM\d[\w.-]*/g)].map(
          (match) => `${ID_PREFIX}${match[0]}`,
        )
    if (named.some((id) => !ids.includes(id))) return new Map()
    for (const id of named) {
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
  platform: MinimaxPlatform = MINIMAX,
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
    if (adaptive < 0 || !platform.thinkingOn.test(cells[adaptive] ?? ''))
      continue
    const off = cells[disabled] ?? ''
    const mandatory = platform.cannotDisable.test(off)
    if (!mandatory && !platform.thinkingOff.test(off)) continue
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
    ...(description.match(platform.efforts)?.[1] ?? '').matchAll(/`([a-z]+)`/g),
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
 * maximum is N; for other models … the maximum is M`. The `other models`
 * number goes only to ids the description never names. Empty unless every
 * id it does name got a maximum from its own clause, so a reworded clause
 * cannot hand a named model the catch-all. Also empty when one clause
 * holds two maximums or names ids beside `other models` (the clauses ran
 * together), or when a maximum carries a unit (`512K`) or a decimal.
 */
export function parseMinimaxMaxOutput(
  description: string,
  ids: Array<string>,
  platform: MinimaxPlatform = MINIMAX,
): Map<string, number> {
  const out = new Map<string, number>()
  let others: number | null = null
  for (const clause of description.split(platform.clause)) {
    const maximums = [...clause.matchAll(new RegExp(platform.maximum, 'g'))]
    const [found] = maximums
    if (!found) continue
    const after = clause.slice(found.index + found[0].length)
    if (maximums.length > 1 || /^(?:\.\d|\s*[kKmM万千亿])/.test(after)) {
      return new Map()
    }
    const tokens = tokenCount(found[1])
    if (tokens === null) continue
    const named = ids.filter((id) => names(clause, id))
    if (named.length > 0 && platform.otherModels.test(clause)) return new Map()
    for (const id of named) out.set(id, tokens)
    if (named.length === 0 && platform.otherModels.test(clause)) others = tokens
  }
  const named = ids.filter((id) => names(description, id))
  if (named.length === 0 || named.some((id) => !out.has(id))) return new Map()
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

/**
 * `~~\$0.60~~ \$0.30 / M tokens` → 0.30: the struck list price is not
 * billed. The caller takes a struck row only under a `Permanent` badge.
 */
function perMillion(cell: string, price: RegExp): number | null {
  const billed = cell.replace(/~~[^~]*~~/g, '').trim()
  const amount = billed.match(price)?.[1]
  return amount ? Number(amount) : null
}

/** A price row's first cell: the bold id, then any bound or badge. */
const MODEL_CELL = /^\*\*([A-Za-z0-9][\w.-]*)\*\*(.*)$/

export interface MinimaxRates {
  base: Record<string, number>
  tiers: Array<TokenRateTier>
}

/**
 * The `## LLM` tables, standard tier only: the `Priority` tab is dropped.
 * A `> 512k input tokens` row is a tier over the same model's base row.
 * Rates are per token, in the platform's currency.
 *
 * What it cannot attribute it refuses. Nothing is priced when a `<Tab`
 * other than the standard one survives, or the section holds a heading
 * of its own. A model gets no price when a row of its has text beside the
 * id that is not a bound or the permanent badge, a price cell that does
 * not read, a second base row, or a repeated tier threshold.
 */
export function parseMinimaxPricing(
  markdown: string,
  platform: MinimaxPlatform = MINIMAX,
): Map<string, MinimaxRates> {
  const tabbed = markdownSection(markdown, platform.priceSection)
    .replace(
      new RegExp(
        `<Tab title="(?!${platform.standardTab}")[^"]*">[\\s\\S]*?</Tab>`,
        'g',
      ),
      '',
    )
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
  const out = new Map<string, MinimaxRates>()
  // A tab the strip did not recognise, or a sub-heading, may hold another
  // tier's table under the same headers.
  const standard = `<Tab title="${platform.standardTab}">`
  if (
    /<Tab(?!s>)/.test(tabbed.replaceAll(standard, '')) ||
    /^#{1,6} /m.test(tabbed.slice(tabbed.indexOf('\n')))
  ) {
    return out
  }
  // So may an accordion that is not the legacy models. One with no price
  // row (a FAQ) is dropped; one with a price row cannot be attributed.
  const priceRow = (cells: Array<string>) =>
    cells[0] === platform.modelHeader || MODEL_CELL.test(cells[0] ?? '')
  const foreign: Array<string> = []
  const section = tabbed.replace(
    /<Accordion\b([^>]*)>([\s\S]*?)<\/Accordion>/g,
    (whole, attributes: string, body: string) => {
      const title = /\btitle="([^"]*)"/.exec(attributes)?.[1]
      if (title === platform.legacyAccordion) return whole
      if (markdownTableRows(body).some(priceRow)) foreign.push(whole)
      return ''
    },
  )
  if (foreign.length > 0) return out
  const refused = new Set<string>()
  const based = new Set<string>()
  /** A base row's `≤ N` bound; the first tier must start at the same N. */
  const baseBound = new Map<string, number | null>()
  let header: Array<string> = []
  for (const cells of markdownTableRows(section)) {
    if (cells[0] === platform.modelHeader) {
      header = cells
      continue
    }
    const model = cells[0]?.match(MODEL_CELL)
    const id = model?.[1]
    if (!id) continue
    // A struck price without a `Permanent` badge may be a promotion that
    // ends: the model gets no card.
    const struck = cells.some((cell) => cell.includes('~~'))
    if (struck && !platform.permanent.test(model[2] ?? '')) {
      refused.add(id)
      continue
    }
    const rates: Record<string, number> = {}
    // Every column beside the model is a price this must read: an unknown
    // header or a cell that does not parse refuses the model, so a lever
    // is never dropped from a card that still prices the rest.
    let unread = cells.length !== header.length
    header.slice(1).forEach((name, index) => {
      const lever = platform.priceLevers[name]
      const amount = lever
        ? perMillion(cells[index + 1] ?? '', platform.price)
        : null
      if (lever && amount !== null) rates[lever] = amount / 1e6
      else unread = true
    })
    const bound = model[2]?.match(platform.inputBound)
    const above = bound?.[1] === '>' ? tokenCount(bound[2]) : null
    // Beside the id: a bound, the permanent badge, a footnote mark. Any
    // other text qualifies the price in a way this does not read.
    const qualifier = (model[2] ?? '')
      .replace(/<span[^>]*>[^<]*<\/span>/g, (span) =>
        platform.permanent.test(span) ? '' : span,
      )
      .replace(bound?.[0] ?? '', '')
      .replace(/<br \/>|\\\*/g, '')
      .trim()
    const entry = out.get(id) ?? { base: {}, tiers: [] }
    const repeated =
      above === null
        ? based.has(id)
        : entry.tiers.some((tier) => tier.minPromptTokens === above)
    if (
      unread ||
      rates.input_tokens === undefined ||
      rates.output_tokens === undefined ||
      qualifier !== '' ||
      (bound && bound[1] === '>' && above === null) ||
      repeated
    ) {
      refused.add(id)
      continue
    }
    if (above !== null) entry.tiers.push({ minPromptTokens: above, rates })
    else {
      entry.base = rates
      based.add(id)
      if (bound) baseBound.set(id, tokenCount(bound[2]))
    }
    out.set(id, entry)
  }
  for (const [id, entry] of out) {
    // `≤ 256k` beside `> 512k` leaves 256k–512k unpriced, and a bounded
    // base with no tier leaves everything above it: neither is a card.
    const tiers = entry.tiers.map((tier) => tier.minPromptTokens)
    const first = tiers.length > 0 ? Math.min(...tiers) : undefined
    if (baseBound.has(id) ? baseBound.get(id) !== first : first !== undefined) {
      refused.add(id)
    }
  }
  for (const id of refused) out.delete(id)
  return out
}

const FETCH_TIMEOUT_MS = 30_000

/**
 * One docs page. Throws when a redirect lands on a host that is not the
 * platform's own: the two platforms publish the same paths, so a redirect
 * across them would hand one platform the other's document.
 */
export async function fetchMinimaxPage(
  url: string,
  platform: MinimaxPlatform,
): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(
      `fetch failed: ${url} → ${String(response.status)} ${response.statusText}`,
    )
  }
  const host = new URL(response.url || url).host
  if (!platform.hosts.includes(host)) {
    throw new Error(`${platform.label}: ${url} was answered by ${host}`)
  }
  return response.text()
}

/** Facts for one chat id; `{}` when the docs do not name it. */
export async function minimaxModelFacts(
  kv?: KVNamespace,
  platform: MinimaxPlatform = MINIMAX,
): Promise<(rawId: string) => Partial<ModelFacts>> {
  const { label, sdkUrl, chatSpecUrl, pricingUrl } = platform
  const fetchPage = (url: string) => fetchMinimaxPage(url, platform)
  const doc = await cachedDocs(kv, sdkUrl, async () => {
    const [sdk, pricingPage, specText] = await Promise.all([
      fetchPage(sdkUrl),
      fetchPage(pricingUrl),
      fetchPage(chatSpecUrl),
    ])
    const windows = parseMinimaxContextWindows(sdk, platform)
    assertParsed(windows, `${label} context windows`)
    const ids = [...windows.keys()]
    const inputs = parseMinimaxInputModalities(sdk, ids, platform)
    assertParsed(inputs, `${label} input modalities`)
    const reasoning = parseMinimaxReasoning(sdk, ids, platform)
    assertParsed(reasoning, `${label} thinking table`)
    const caps = parseMinimaxMaxOutput(
      maxCompletionTokensDescription(JSON.parse(specText) as unknown),
      ids,
      platform,
    )
    assertParsed(caps, `${label} max output`)
    const prices = parseMinimaxPricing(pricingPage, platform)
    assertParsed(prices, `${label} pricing page`)

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
      // A maximum equal to the model's whole context window is the context
      // bound, not an output cap: nothing is stored for it.
      const cap = caps.get(id)
      const maxOutput =
        cap === undefined || cap === fromSdk.contextWindow ? null : cap
      const rates = prices.get(id)
      const pricing = rates
        ? compileTokenCard(
            rates.base,
            rates.tiers,
            { url: pricingUrl, hash: pricingHash, extractedAt },
            { currency: platform.currency },
          )
        : null
      facts[id] = {
        ...fromSdk,
        maxOutput,
        pricing,
        factSources: {
          ...tagDocsFacts(fromSdk, sdkUrl, sdkHash),
          ...tagDocsFacts({ maxOutput }, chatSpecUrl, specHash),
          ...tagDocsFacts({ pricing }, pricingUrl, pricingHash),
        },
      }
    }
    return { facts }
  })
  return (rawId) => doc.facts[rawId] ?? {}
}
