/**
 * Cerebras model pages linked from the catalog (issue #109). Each page's
 * `<ModelInfo>` states the API id, paid prices per million tokens, the
 * paid output cap, input and output formats, and feature names. The
 * marketing pricing page is a client render and is not parsed.
 *
 * As of 2026-10-20 a page's `.md` export renders `<ModelInfo>` as bare
 * labels with no values (issue #381), so the HTML page is read: its RSC
 * payload (`self.__next_f.push`) embeds the compiled MDX,
 * `_jsx(ModelInfo,{…})` with the same props as template literals. It
 * carries the body twice, and on some pages the second copy has no
 * `pricing`, `contextLength`, or `maxOutput`, so the copy with `pricing`
 * is read. The `<ModelInfo …/>` JSX (the MDX source) is still accepted.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import { closing } from './compiled-mdx.ts'
import { tagDocsFacts } from './fact-sources.ts'
import {
  assertParsed,
  cachedDocs,
  mapConcurrent,
  tokenCount,
} from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const CEREBRAS_CATALOG_URL =
  'https://inference-docs.cerebras.ai/models/overview.md'

const PAGE = (slug: string) =>
  `https://inference-docs.cerebras.ai/models/${slug}`

export interface CerebrasModelFacts {
  inputPerMillion: number | null
  outputPerMillion: number | null
  modalities: { input: Array<string>; output: Array<string> } | null
  capabilities: Array<string>
  /** Paid window. A parenthetical integer beats `128k` → 128,000. */
  contextWindow: number | null
  /** Paid-tier cap. A parenthetical integer beats `40k` → 40,000. */
  maxOutput: number | null
}

const FEATURES: Record<string, Array<string>> = {
  Reasoning: ['reasoning'],
  'Tool Calling': ['tools'],
  'Structured Outputs': ['structured_outputs', 'response_format'],
}

/** A `"…"` (MDX source) or `` `…` `` (compiled MDX) string; quotes are not paired. */
const STRING = '["`]([^"`]*)["`]'

/**
 * The prose sentence after `label`. It ends at its full stop, a newline
 * (`\\n` once JSON-escaped in the payload), or the end of its template
 * literal, so the context sentence never reaches the max output one.
 */
function proseSentence(page: string, label: RegExp): string | undefined {
  const rest = page.match(
    new RegExp(`${label.source}\\s*([^\\n\`]+)`, 'i'),
  )?.[1]
  return rest?.split(/\.\s|\\n/)[0]
}

function dollars(cell: string): number | null {
  const match = cell.match(/\$(\d+(?:\.\d+)?)/)
  return match?.[1] ? Number(match[1]) : null
}

/**
 * `128K tokens (131,072) for paid` is 131072. The first `Nk (exact) for paid`
 * wins, so a free-tier parenthetical earlier in the sentence is ignored.
 */
function paidParenthetical(sentence: string | undefined): number | null {
  const exact = sentence?.match(
    /(\d+(?:\.\d+)?)\s*k\s+tokens?\s*\(([\d,]+)\)\s+for paid\b/i,
  )?.[2]
  if (!exact) return null
  const count = Number(exact.replace(/,/g, ''))
  if (!Number.isFinite(count)) {
    throw new Error(`cerebras model page: unreadable paid token count`)
  }
  return count
}

/**
 * Paid context window. The prose parenthetical beats `<ModelInfo>` (`128k`
 * → 128,000). An unreadable paid tier throws.
 */
function paidContextWindow(page: string, block: string): number | null {
  const sentence = proseSentence(page, /context window:/)
  const exact = paidParenthetical(sentence)
  if (exact != null) return exact
  const contextPaid = block.match(/contextLength(?:=\{\{|:\{)([^}]*)\}/)?.[1]
  const paid = contextPaid?.match(new RegExp(`paidTiers:\\s*${STRING}`))?.[1]
  if (paid === undefined) return null
  if (paid.trim() === '' || /^n\/a$/i.test(paid.trim())) return null
  const count = tokenCount(paid)
  if (count == null) {
    throw new Error(
      `cerebras model page: unreadable paid context window "${paid}"`,
    )
  }
  return count
}

/**
 * Paid max output. `40K tokens (40,960) for paid` is 40960. Otherwise the
 * `<ModelInfo>` paid tier (`40k` → 40,000). An unreadable tier throws.
 */
function paidMaxOutput(page: string, block: string): number | null {
  const sentence = proseSentence(page, /max(?:imum)? output:/)
  const exact = paidParenthetical(sentence)
  if (exact != null) return exact
  const paid = block.match(/maxOutput(?:=\{\{|:\{)([^}]*)\}/)?.[1]
  if (!paid) return null
  const tiers = paid.match(new RegExp(`paidTiers:\\s*${STRING}`))?.[1]
  if (tiers === undefined) return null
  if (tiers.trim() === '' || /^n\/a$/i.test(tiers.trim())) return null
  const count = tokenCount(tiers)
  if (count == null) {
    throw new Error(
      `cerebras model page: unreadable paid max output "${tiers}"`,
    )
  }
  return count
}

function quotedList(block: string, key: string): Array<string> {
  const match = block.match(
    new RegExp(`${key}(?:=|:)?\\s*\\{?\\s*\\[([^\\]]*)\\]`),
  )
  if (!match?.[1]) return []
  return [...match[1].matchAll(/["`]([^"`]+)["`]/g)].map(
    (item) => item[1] ?? '',
  )
}

/**
 * The `<ModelInfo …/>` JSX, else the `{…}` props of each compiled
 * `_jsx(s)(ModelInfo,{…})`: the copies with `pricing`, or all of them when
 * none has it.
 */
function modelInfoBlocks(page: string): Array<string> {
  const jsx = page.match(/<ModelInfo[\s\S]*?\/>/)?.[0]
  if (jsx) return [jsx]
  const blocks = [...page.matchAll(/_jsxs?\(ModelInfo,\{/g)].map((call) => {
    const open = call.index + call[0].length - 1
    return page.slice(open, closing(page, open, 'cerebras model page') + 1)
  })
  const priced = blocks.filter((block) => /\bpricing:\{/.test(block))
  return priced.length > 0 ? priced : blocks
}

/** Catalog table: link slug plus the backticked API id. */
export function cerebrasCatalogRows(
  markdown: string,
): Array<{ slug: string; id: string }> {
  const out: Array<{ slug: string; id: string }> = []
  const re = /\[[^\]]+\]\(\/models\/([a-z0-9.-]+)\)\s*\|\s*`([^`]+)`/g
  for (const match of markdown.matchAll(re)) {
    if (match[1] && match[2]) out.push({ slug: match[1], id: match[2] })
  }
  return out
}

/**
 * Facts from the page's `<ModelInfo>`; null when it has none. Throws when
 * two compiled copies with `pricing` state different facts.
 */
export function parseCerebrasModelPage(
  page: string,
): CerebrasModelFacts | null {
  const [first, ...rest] = modelInfoBlocks(page).map((block) =>
    blockFacts(page, block),
  )
  if (!first) return null
  const stated = JSON.stringify(first)
  if (rest.some((facts) => JSON.stringify(facts) !== stated)) {
    throw new Error('cerebras model page: ModelInfo copies disagree')
  }
  return first
}

function blockFacts(page: string, block: string): CerebrasModelFacts {
  const input = dollars(
    block.match(new RegExp(`inputPrice:\\s*${STRING}`))?.[1] ?? '',
  )
  const output = dollars(
    block.match(new RegExp(`outputPrice:\\s*${STRING}`))?.[1] ?? '',
  )
  const inputFormats = quotedList(block, 'inputFormats')
  const outputFormats = quotedList(block, 'outputFormats')
  const features = quotedList(block, 'features')
  const capabilities = features.flatMap((feature) => FEATURES[feature] ?? [])
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    modalities:
      inputFormats.length > 0 || outputFormats.length > 0
        ? { input: inputFormats, output: outputFormats }
        : null,
    capabilities,
    contextWindow: paidContextWindow(page, block),
    maxOutput: paidMaxOutput(page, block),
  }
}

type Attached = Pick<
  ModelInfo,
  | 'pricing'
  | 'modalities'
  | 'capabilities'
  | 'contextWindow'
  | 'maxOutput'
  | 'factSources'
>

export async function cerebrasModelFacts(
  kv?: KVNamespace,
): Promise<(rawId: string) => Attached> {
  const doc = await cachedDocs(kv, CEREBRAS_CATALOG_URL, async () => {
    const catalog = await fetchText(CEREBRAS_CATALOG_URL)
    const rows = cerebrasCatalogRows(catalog)
    assertParsed(new Map(rows.map((row) => [row.id, row])), 'cerebras catalog')
    const pages = await mapConcurrent(rows, 4, async (row) => {
      const url = PAGE(row.slug)
      const html = await fetchText(url)
      return { id: row.id, url, html, facts: parseCerebrasModelPage(html) }
    })
    const priced = pages.filter((page) => page.facts?.inputPerMillion)
    assertParsed(
      new Map(priced.map((page) => [page.id, page])),
      'cerebras model pages',
    )
    const hash = await sha256Text(pages.map((page) => page.html).join('\n'))
    return {
      byId: Object.fromEntries(
        pages.flatMap((page) =>
          page.facts ? [[page.id, { ...page.facts, url: page.url }]] : [],
        ),
      ),
      hash,
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId) => {
    const row = doc.byId[rawId]
    if (!row) return {}
    const rates: Record<string, number> = {}
    if (row.inputPerMillion) rates.input_tokens = row.inputPerMillion / 1e6
    if (row.outputPerMillion) rates.output_tokens = row.outputPerMillion / 1e6
    const pricing = compileTokenCard(rates, [], {
      url: row.url,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    })
    const facts = {
      ...(pricing ? { pricing } : {}),
      ...(row.modalities ? { modalities: row.modalities } : {}),
      ...(row.capabilities.length > 0
        ? { capabilities: row.capabilities }
        : {}),
      ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
      ...(row.maxOutput != null ? { maxOutput: row.maxOutput } : {}),
    }
    return { ...facts, factSources: tagDocsFacts(facts, row.url, doc.hash) }
  }
}
