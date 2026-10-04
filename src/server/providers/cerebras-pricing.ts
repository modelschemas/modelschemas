/**
 * Cerebras model pages linked from the catalog (issue #109). Each page's
 * `<ModelInfo>` states the API id, paid prices per million tokens, input
 * and output formats, and feature names. The marketing pricing page is a
 * client render and is not parsed.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import { assertParsed, cachedDocs, mapConcurrent } from './model-facts.ts'
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
  contextWindow: number | null
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
  const paid = block.match(/paidTiers:\s*"([^"]+)"/)?.[1]
  const context = paid?.match(/([\d.]+)\s*k/i)
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    modalities:
      inputFormats.length > 0 || outputFormats.length > 0
        ? { input: inputFormats, output: outputFormats }
        : null,
    capabilities,
    contextWindow: context?.[1] ? Number(context[1]) * 1000 : null,
  }
}

type Attached = Pick<
  ModelInfo,
  'pricing' | 'modalities' | 'capabilities' | 'contextWindow'
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
    return {
      ...(pricing ? { pricing } : {}),
      ...(row.modalities ? { modalities: row.modalities } : {}),
      ...(row.capabilities.length > 0
        ? { capabilities: row.capabilities }
        : {}),
      ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
    }
  }
}
