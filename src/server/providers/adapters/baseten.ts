/**
 * Baseten Model APIs. Slugs, context, and vision come from the overview.
 * Efforts come from the reasoning page. Token prices come from baseten.co/pricing
 * (USD per 1M tokens). Schemas are Baseten's published OpenAPI documents.
 * A model with no dollar amount on the pricing page stays unpriced.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import type { Activity } from '#/db/schema.ts'

import { fetchOpenApi, fetchText, sha256Text } from '../types.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelFactSources,
  ModelInfo,
  ModelReasoning,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const BASETEN_OVERVIEW_URL =
  'https://docs.baseten.co/inference/model-apis/overview.md'
export const BASETEN_REASONING_URL =
  'https://docs.baseten.co/inference/model-apis/reasoning.md'
export const BASETEN_VISION_URL =
  'https://docs.baseten.co/inference/model-apis/vision.md'
export const BASETEN_PRICING_URL = 'https://www.baseten.co/pricing'
export const BASETEN_CHAT_OPENAPI_URL =
  'https://docs.baseten.co/reference/inference-api/llm-openapi-spec.json'
export const BASETEN_MESSAGES_OPENAPI_URL =
  'https://docs.baseten.co/reference/inference-api/messages-openapi-spec.json'

const CHAT_ENDPOINT = 'v1/chat/completions'

interface ListedModel {
  name: string
  slug: string
  context: number
  maxOutput: number
  vision: boolean
}

interface TokenQuote {
  input: number
  cache: number | null
  output: number
}

export interface BasetenPages {
  overview: string
  reasoning: string
  vision: string
  pricingHtml: string
  pricingSource: RateCard['source']
  overviewHash: string
  reasoningHash: string
  visionHash: string
}

function cells(line: string): Array<string> | null {
  if (!line.startsWith('|')) return null
  const row = line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
  if (row.length === 0 || row.every((cell) => /^:?-+:?$/.test(cell)))
    return null
  return row
}

function docsSource(url: string, hash: string, path: string): FactSource {
  return {
    derivation: 'docs-derived',
    sourceUrl: url,
    sourceHash: hash,
    path,
  }
}

function parseOverview(markdown: string): Array<ListedModel> {
  if (
    !markdown.includes('{row.context}k') ||
    !markdown.includes('{row.maxOutput}k')
  ) {
    throw new Error('baseten: overview context is not labeled in thousands')
  }
  const models: Array<ListedModel> = []
  const seen = new Set<string>()
  const row =
    /model:\s*"([^"]+)",\s*slug:\s*"([^"]+)",\s*context:\s*(\d+),\s*maxOutput:\s*(\d+)/g
  for (const match of markdown.matchAll(row)) {
    const slug = match[2] ?? ''
    if (slug.length === 0 || seen.has(slug)) continue
    seen.add(slug)
    models.push({
      name: match[1] ?? '',
      slug,
      context: Number(match[3]) * 1000,
      maxOutput: Number(match[4]) * 1000,
      vision: false,
    })
  }
  if (models.length === 0) {
    throw new Error('baseten: overview listed no model slugs')
  }
  const features =
    /model:\s*"([^"]+)",\s*reasoning:\s*"([^"]+)",\s*vision:\s*"([^"]+)"/g
  const vision = new Map<string, boolean>()
  for (const match of markdown.matchAll(features)) {
    const mark = match[3] ?? ''
    vision.set(match[1] ?? '', mark.includes('✓') || /^yes$/i.test(mark))
  }
  if (vision.size === 0) {
    throw new Error('baseten: overview listed no feature rows')
  }
  return models.map((model) => ({
    ...model,
    vision: vision.get(model.name) ?? false,
  }))
}

function parseEfforts(markdown: string): Map<string, Array<string>> {
  const start = markdown.search(/^## Control reasoning depth/m)
  if (start < 0) {
    throw new Error('baseten: reasoning page has no effort table')
  }
  const rest = markdown.slice(start)
  const next = rest.slice(1).search(/^## /m)
  const section = next < 0 ? rest : rest.slice(0, next + 1)
  const efforts = new Map<string, Array<string>>()
  for (const line of section.split('\n')) {
    const row = cells(line)
    if (!row || row.length < 2 || row[0] === 'Model') continue
    const values = (row[1] ?? '')
      .replace(/\(default\)/gi, '')
      .split(',')
      .map((value) => value.replace(/`/g, '').trim())
      .filter((value) => value.length > 0)
    if (values.length === 0) continue
    efforts.set(row[0] ?? '', values)
  }
  if (efforts.size === 0) {
    throw new Error('baseten: reasoning page listed no efforts')
  }
  return efforts
}

function alwaysOnPrefixes(markdown: string): Array<string> {
  const match = /Thinking is always on for the ([^,\n]+?) family/i.exec(
    markdown,
  )
  const prefix = match?.[1]?.trim()
  return prefix ? [prefix] : []
}

function videoNames(markdown: string): Set<string> {
  let header: Array<string> | null = null
  for (const line of markdown.split('\n')) {
    const row = cells(line)
    if (!row) continue
    if (row[0] === 'Limit') {
      header = row
      continue
    }
    if (!header || !/^max videos per request$/i.test(row[0] ?? '')) continue
    const names = new Set<string>()
    for (let index = 1; index < header.length; index += 1) {
      const name = header[index]
      if (name && /^\d/.test(row[index] ?? '')) names.add(name)
    }
    return names
  }
  return new Set()
}

function dollars(slice: string): Array<number> {
  const amounts = [...slice.matchAll(/\$([0-9]+(?:\.[0-9]+)?)/g)].map((match) =>
    Number(match[1]),
  )
  const collapsed: Array<number> = []
  for (const amount of amounts) {
    if (collapsed.at(-1) !== amount) collapsed.push(amount)
  }
  return collapsed
}

function parsePrices(html: string): {
  bySlug: Map<string, TokenQuote>
  byName: Map<string, TokenQuote>
} {
  if (!/1M tokens/i.test(html)) {
    throw new Error('baseten: pricing page has no per-1M-token section')
  }
  const bySlug = new Map<string, TokenQuote>()
  const byName = new Map<string, TokenQuote>()
  const links = [
    ...html.matchAll(/href="https:\/\/app\.baseten\.co\/model-apis\/([^"]+)"/g),
  ]
  const seen = new Set<string>()
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index]
    const path = link?.[1]
    if (!link || !path || seen.has(path)) continue
    seen.add(path)
    const start = Math.max(links[index - 1]?.index ?? 0, link.index - 4000)
    const before = html.slice(start, link.index)
    const name = [...before.matchAll(/<p[^>]*>([^<]+)<\/p>/g)].at(-1)
    const amounts = dollars(before.slice(name?.index ?? 0))
    if (amounts.length !== 2 && amounts.length !== 3) {
      throw new Error(`baseten: pricing row ${path} has no input and output`)
    }
    if (amounts.some((amount) => !Number.isFinite(amount) || amount <= 0)) {
      throw new Error(`baseten: pricing row ${path} has a non-positive amount`)
    }
    const quote: TokenQuote = {
      input: amounts[0] ?? 0,
      cache: amounts.length === 3 ? (amounts[1] ?? null) : null,
      output: amounts.at(-1) ?? 0,
    }
    const label = name?.[1]?.trim()
    if (path.includes('/')) bySlug.set(path, quote)
    if (label) byName.set(label, quote)
  }
  if (bySlug.size === 0 && byName.size === 0) {
    throw new Error('baseten: pricing page listed no model prices')
  }
  return { bySlug, byName }
}

function reasoningFor(
  name: string,
  efforts: Map<string, Array<string>>,
  families: Array<string>,
): ModelReasoning | null {
  const values = efforts.get(name)
  if (!values) return null
  const alwaysOn = families.some(
    (family) => name === family || name.startsWith(`${family} `),
  )
  return {
    mode: 'effort',
    mandatory: alwaysOn || !values.includes('none'),
    efforts: values,
  }
}

function perToken(dollarsPerMillion: number): number {
  return dollarsPerMillion / 1_000_000
}

/** Catalog rows from Baseten's own docs. Prices stay null when unnamed. */
export function parseBasetenCatalog(pages: BasetenPages): Array<ModelInfo> {
  const listed = parseOverview(pages.overview)
  const efforts = parseEfforts(pages.reasoning)
  const families = alwaysOnPrefixes(pages.reasoning)
  const video = videoNames(pages.vision)
  const prices = parsePrices(pages.pricingHtml)
  return listed.map((model) => {
    const quote =
      prices.bySlug.get(model.slug) ?? prices.byName.get(model.name) ?? null
    const pricing = quote
      ? compileTokenCard(
          {
            input_tokens: perToken(quote.input),
            output_tokens: perToken(quote.output),
            ...(quote.cache !== null
              ? { cache_read_tokens: perToken(quote.cache) }
              : {}),
          },
          [],
          pages.pricingSource,
        )
      : null
    const reasoning = reasoningFor(model.name, efforts, families)
    const input = ['text']
    if (model.vision) input.push('image')
    if (video.has(model.name)) input.push('video')
    const modalityUrl = video.has(model.name)
      ? BASETEN_VISION_URL
      : BASETEN_OVERVIEW_URL
    const modalityHash = video.has(model.name)
      ? pages.visionHash
      : pages.overviewHash
    const factSources: ModelFactSources = {
      contextWindow: docsSource(
        BASETEN_OVERVIEW_URL,
        pages.overviewHash,
        'SupportedModelsTable',
      ),
      maxOutput: docsSource(
        BASETEN_OVERVIEW_URL,
        pages.overviewHash,
        'SupportedModelsTable',
      ),
      modalities: docsSource(modalityUrl, modalityHash, 'modalities'),
    }
    if (pricing) {
      factSources.pricing = docsSource(
        BASETEN_PRICING_URL,
        pages.pricingSource.hash,
        'Model APIs',
      )
    }
    if (reasoning) {
      factSources.reasoning = docsSource(
        BASETEN_REASONING_URL,
        pages.reasoningHash,
        'reasoning_effort',
      )
    }
    return {
      rawId: model.slug,
      displayName: model.name,
      activity: 'chat' as const,
      contextWindow: model.context,
      maxOutput: model.maxOutput,
      modalities: { input, output: ['text'] },
      pricing,
      reasoning,
      factSources,
    }
  })
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const [overview, reasoning, vision, pricingHtml] = await Promise.all([
    fetchText(BASETEN_OVERVIEW_URL),
    fetchText(BASETEN_REASONING_URL),
    fetchText(BASETEN_VISION_URL),
    fetchText(BASETEN_PRICING_URL),
  ])
  const [overviewHash, reasoningHash, visionHash, pricingHash] =
    await Promise.all([
      sha256Text(overview),
      sha256Text(reasoning),
      sha256Text(vision),
      sha256Text(pricingHtml),
    ])
  return {
    models: parseBasetenCatalog({
      overview,
      reasoning,
      vision,
      pricingHtml,
      overviewHash,
      reasoningHash,
      visionHash,
      pricingSource: {
        url: BASETEN_PRICING_URL,
        hash: pricingHash,
        extractedAt: new Date().toISOString(),
      },
    }),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const [chat, messages] = await Promise.all([
    fetchOpenApi(BASETEN_CHAT_OPENAPI_URL),
    fetchOpenApi(BASETEN_MESSAGES_OPENAPI_URL),
  ])
  return {
    specs: [chat.spec, messages.spec],
    sources: [
      { url: BASETEN_CHAT_OPENAPI_URL, hash: chat.hash },
      { url: BASETEN_MESSAGES_OPENAPI_URL, hash: messages.hash },
    ],
    outputStrategy: 'post-200',
    specRevision: chat.hash,
  }
}

export function classifyBasetenPath(path: string): Activity | null {
  const bare = path.replace(/^\//, '')
  if (bare === CHAT_ENDPOINT || bare === 'v1/messages') return 'chat'
  return null
}

export const provider: ProviderConfig = {
  id: 'baseten',
  displayName: 'Baseten',
  specSourceUrl: BASETEN_CHAT_OPENAPI_URL,
  modelsEndpoint: BASETEN_OVERVIEW_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify: (path) => classifyBasetenPath(path),
  generationEndpointId: ({ activity }) =>
    activity === 'chat' ? CHAT_ENDPOINT : null,
}
