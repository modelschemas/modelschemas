/**
 * Cerebras model pages linked from the catalog (issue #109). Each page's
 * `<ModelInfo>` states the API id, paid prices per million tokens, the
 * paid output cap, input and output formats, and feature names. The
 * marketing pricing page is a client render and is not parsed.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

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
  `https://inference-docs.cerebras.ai/models/${slug}.md`

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
function paidContextWindow(markdown: string, block: string): number | null {
  const sentence = markdown.match(/context window:\s*([^\n]+)/i)?.[1]
  const exact = paidParenthetical(sentence)
  if (exact != null) return exact
  const contextPaid = block.match(/contextLength=\{\{([\s\S]*?)\}\}/)?.[1]
  const paid = contextPaid?.match(/paidTiers:\s*"([^"]*)"/)?.[1]
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
function paidMaxOutput(markdown: string, block: string): number | null {
  const sentence = markdown.match(/max(?:imum)? output:\s*([^\n]+)/i)?.[1]
  const exact = paidParenthetical(sentence)
  if (exact != null) return exact
  const paid = block.match(/maxOutput=\{\{([\s\S]*?)\}\}/)?.[1]
  if (!paid) return null
  const tiers = paid.match(/paidTiers:\s*"([^"]*)"/)?.[1]
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
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? '')
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

export function parseCerebrasModelPage(
  markdown: string,
): CerebrasModelFacts | null {
  const block = markdown.match(/<ModelInfo[\s\S]*?\/>/)?.[0]
  if (!block) return null
  const input = dollars(block.match(/inputPrice:\s*"([^"]+)"/)?.[1] ?? '')
  const output = dollars(block.match(/outputPrice:\s*"([^"]+)"/)?.[1] ?? '')
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
    contextWindow: paidContextWindow(markdown, block),
    maxOutput: paidMaxOutput(markdown, block),
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
      const markdown = await fetchText(url)
      return {
        id: row.id,
        url,
        markdown,
        facts: parseCerebrasModelPage(markdown),
      }
    })
    const priced = pages.filter((page) => page.facts?.inputPerMillion)
    assertParsed(
      new Map(priced.map((page) => [page.id, page])),
      'cerebras model pages',
    )
    const hash = await sha256Text(pages.map((page) => page.markdown).join('\n'))
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
