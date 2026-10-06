/**
 * Cloudflare AI Gateway — third-party models from Cloudflare's own catalog.
 *
 * The index at developers.cloudflare.com/ai/models/ lists Workers AI (`@cf/`)
 * and AI Gateway models. Workers AI stays on `cloudflare-workers-ai`. This
 * adapter keeps the two-segment `author/model` ids (the REST form, for
 * example `anthropic/claude-fable-5`).
 *
 * A per-1M-token price is stored only when that model's page names input
 * and output in those units, plus cached input or cache creation when
 * those rows are present. Per-second, per-image, and every other unit
 * stay null. There is no first-party OpenAPI document, so fetchSpec skips.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import {
  cachedDocs,
  mapConcurrent,
  markdownTableRows,
  tokenCount,
} from '../model-facts.ts'
import { fetchText, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const CATALOG_URL = 'https://developers.cloudflare.com/ai/models/'

const CATALOG_MARKDOWN = `${CATALOG_URL}index.md`

export const SPEC_SKIP =
  'cloudflare-ai-gateway: no first-party OpenAPI document — skipped'

const TASK_ACTIVITY: Record<string, Activity> = {
  'Text Generation': 'chat',
  'Text-to-Image': 'image',
  'Image-to-Image': 'image',
  'Text-to-Video': 'video',
  'Image-to-Video': 'video',
  'video-to-video': 'video',
  'Text-to-Speech': 'audio',
  'Automatic Speech Recognition': 'audio',
  'Music Generation': 'audio',
}

const TOKEN_LEVERS: Record<string, string> = {
  Input: 'input_tokens',
  Output: 'output_tokens',
  'Cached input': 'cache_read_tokens',
  'Cache creation': 'cache_write_tokens',
}

/** Gateway model page URLs linked from the catalog index, in page order. */
export function catalogPageUrls(markdown: string): Array<string> {
  const urls: Array<string> = []
  const seen = new Set<string>()
  for (const match of markdown.matchAll(
    /https:\/\/developers\.cloudflare\.com\/ai\/models\/([a-z0-9][a-z0-9.-]*)\/([a-z0-9][a-z0-9._-]*)\/(?![a-z0-9@])/g,
  )) {
    const author = match[1]
    const model = match[2]
    if (!author || !model) continue
    const url = `${CATALOG_URL}${author}/${model}/`
    if (seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

function pageMarkdownUrl(pageUrl: string): string {
  return pageUrl.endsWith('/') ? `${pageUrl}index.md` : pageUrl
}

/**
 * Token card from the Model Info pricing list. Any row that is not a
 * per-1M-token input, output, or cache rate nulls the card.
 */
function tokenCard(head: string, source: RateCard['source']): RateCard | null {
  const items = [...head.matchAll(/<li>([^<]*)<\/li>/g)].map((match) =>
    (match[1] ?? '').trim(),
  )
  if (items.length === 0) return null
  const rates: Record<string, number> = {}
  for (const item of items) {
    const match = item.match(
      /^(Input|Output|Cached input|Cache creation) \(per 1M tokens\)\$([0-9]+(?:\.[0-9]+)?)$/,
    )
    const label = match?.[1]
    const dollars = match?.[2] ? Number(match[2]) : NaN
    const lever = label ? TOKEN_LEVERS[label] : undefined
    if (!lever || !Number.isFinite(dollars)) return null
    if (lever in rates) return null
    rates[lever] = dollars / 1_000_000
  }
  if (rates.input_tokens === undefined || rates.output_tokens === undefined) {
    return null
  }
  return compileTokenCard(rates, [], source)
}

/** One catalog page, before the usage examples. */
export function parseGatewayModelPage(
  markdown: string,
  pageUrl: string,
  source: RateCard['source'],
): ModelInfo {
  const head = markdown.split('\n## Usage')[0] ?? markdown
  const rawId = head.match(/`([a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._-]*)`/)?.[1]
  if (!rawId) {
    throw new Error(`cloudflare-ai-gateway: ${pageUrl} listed no model id`)
  }
  const task = head.match(/^(.+?) • .+$/m)?.[1]?.trim() ?? null
  const contextCell = markdownTableRows(head).find((row) =>
    row[0]?.startsWith('Context Window'),
  )?.[1]
  return {
    rawId,
    displayName: head.match(/^# (.+)$/m)?.[1]?.trim() ?? null,
    activity: task ? (TASK_ACTIVITY[task] ?? null) : null,
    contextWindow: tokenCount(contextCell),
    pricing: tokenCard(head, source),
  }
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const pages = await cachedDocs(kv, CATALOG_MARKDOWN, async () => {
    const urls = catalogPageUrls(await fetchText(CATALOG_MARKDOWN))
    if (urls.length === 0) {
      throw new Error(
        'cloudflare-ai-gateway: models index listed no gateway ids',
      )
    }
    return urls
  })
  const models = await mapConcurrent(pages, 8, async (pageUrl) => {
    const markdownUrl = pageMarkdownUrl(pageUrl)
    const doc = await cachedDocs(kv, markdownUrl, async () => {
      const markdown = await fetchText(markdownUrl)
      return {
        markdown,
        hash: await sha256Text(markdown),
        extractedAt: new Date().toISOString(),
      }
    })
    return parseGatewayModelPage(doc.markdown, pageUrl, {
      url: pageUrl,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    })
  })
  const seen = new Set<string>()
  for (const model of models) {
    if (seen.has(model.rawId)) {
      throw new Error(
        `cloudflare-ai-gateway: duplicate model id ${model.rawId}`,
      )
    }
    seen.add(model.rawId)
  }
  return { models }
}

function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  return Promise.resolve({
    specs: [],
    sources: [],
    outputStrategy: 'post-200',
    skipped: SPEC_SKIP,
  })
}

export const provider: ProviderConfig = {
  id: 'cloudflare-ai-gateway',
  displayName: 'Cloudflare AI Gateway',
  specSourceUrl: CATALOG_URL,
  modelsEndpoint: CATALOG_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: () => null,
}
