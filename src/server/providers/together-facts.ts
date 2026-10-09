/**
 * Together chat facts the v1 listing leaves empty: reasoning mode from the
 * reasoning guide and model quickstarts, and serverless chat rates / context
 * / vision inputs from the models catalog. Listing values win when both
 * publish a number. A zero listing rate stays unpublished.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import { isCapabilityMap } from '#/lib/capabilities.ts'

import type { ThinkingRequest } from './request-map.ts'
import { tagDocsFacts } from './fact-sources.ts'
import type { cachedDocs } from './model-facts.ts'
import {
  assertParsed,
  markdownSection,
  markdownTableRows,
} from './model-facts.ts'
import { TOGETHER_MODELS_DOCS_URL } from './together-pricing.ts'
import { fetchText, sha256Text } from './types.ts'
import type {
  FactSource,
  ModelFactSources,
  ModelInfo,
  ModelReasoning,
} from './types.ts'

export const TOGETHER_REASONING_URL =
  'https://docs.together.ai/docs/inference/chat/reasoning.md'
export const TOGETHER_KIMI_K3_URL =
  'https://docs.together.ai/docs/kimi-k3-quickstart.md'
export const TOGETHER_GLM_53_URL =
  'https://docs.together.ai/docs/glm-5.3-quickstart.md'
export const TOGETHER_GPT_OSS_URL = 'https://docs.together.ai/docs/gpt-oss.md'

/** Quickstarts that name one model's effort levels. The guide's table does not. */
export const TOGETHER_REASONING_QUICKSTARTS = [
  TOGETHER_KIMI_K3_URL,
  TOGETHER_GLM_53_URL,
  TOGETHER_GPT_OSS_URL,
] as const

const DOC_HEADERS = { 'User-Agent': 'modelschemas' }

export interface TogetherChatRow {
  contextWindow: number | null
  /** USD per million tokens. Absent when the cell is `-`, `Free`, or not a single rate. */
  inputPerMillion: number | null
  cachedPerMillion: number | null
  outputPerMillion: number | null
}

export interface TogetherDocsBundle {
  chat: Record<string, TogetherChatRow>
  /** Vision-table ids the supported-models API did not already describe. */
  vision: Record<string, { input: Array<string>; output: Array<string> }>
  hash: string
  extractedAt: string
}

export interface TogetherReasoningHit {
  reasoning: ModelReasoning
  sourceUrl: string
  sourceHash: string
  thinking?: ThinkingRequest | null
}

function section(markdown: string, heading: string): string {
  const text = markdown.startsWith('## ') ? `\n${markdown}` : markdown
  return markdownSection(text, heading)
}

function stripFences(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '')
}

function clean(cell: string): string {
  return cell.replace(/\\/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim()
}

function modelId(cell: string): string | null {
  const id = clean(cell)
  return /^[A-Za-z0-9][\w.+-]*\/[\w.+-]+$/.test(id) ? id : null
}

/** Quoted effort names in source order. `"low"`, `"medium"`, or `"high"`. */
function quotedLevels(text: string): Array<string> {
  const levels: Array<string> = []
  for (const match of text.matchAll(/"([a-z][a-z0-9]*)"/g)) {
    const level = match[1]
    if (level && !levels.includes(level)) levels.push(level)
  }
  return levels
}

function positiveCount(cell: string): number | null {
  const text = clean(cell)
  if (text === '' || text === '-' || /^free$/i.test(text)) return null
  if (!/^[\d,]+$/.test(text)) return null
  const value = Number(text.replace(/,/g, ''))
  return Number.isFinite(value) && value > 0 ? value : null
}

/** One `$X` cell. `Free`, `-`, and varying copy are not a rate. */
function perMillion(cell: string): number | null {
  const text = clean(cell)
  if (text === '' || text === '-' || /^free$/i.test(text)) return null
  const amounts = [...text.matchAll(/\$(\d+(?:\.\d+)?)/g)]
  if (amounts.length !== 1 || !amounts[0]?.[1]) return null
  const amount = Number(amounts[0][1])
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

/**
 * Serverless chat table. Context `-` and price `Free` stay null.
 * Ids the table omits are absent from the map.
 */
export function parseTogetherChatCatalog(
  markdown: string,
): Map<string, TogetherChatRow> {
  const out = new Map<string, TogetherChatRow>()
  for (const cells of markdownTableRows(section(markdown, 'Chat models'))) {
    const id = modelId(cells[2] ?? '')
    if (!id || out.has(id)) continue
    out.set(id, {
      contextWindow: positiveCount(cells[3] ?? ''),
      inputPerMillion: perMillion(cells[4] ?? ''),
      cachedPerMillion: perMillion(cells[5] ?? ''),
      outputPerMillion: perMillion(cells[6] ?? ''),
    })
  }
  return out
}

/**
 * Vision catalog rows. Input is text plus image; output is text.
 * This table is a subset of the supported-models API.
 */
export function parseTogetherVisionModalities(
  markdown: string,
): Map<string, { input: Array<string>; output: Array<string> }> {
  const out = new Map<string, { input: Array<string>; output: Array<string> }>()
  for (const cells of markdownTableRows(section(markdown, 'Vision models'))) {
    const id = modelId(cells[2] ?? '')
    if (!id || out.has(id)) continue
    out.set(id, { input: ['text', 'image'], output: ['text'] })
  }
  return out
}

/**
 * Reasoning guide table plus the effort sentences on that same page.
 * Hybrid with no listed levels is a toggle that can be turned off.
 * Hybrid plus `accepts only` levels is effort. Adjustable effort uses the
 * levels in the type definition. Reasoning-only rows name no request field.
 */
export function parseTogetherReasoning(
  markdown: string,
): Map<string, ModelReasoning> {
  const prose = stripFences(markdown)
  const defined = prose.match(/Adjustable effort:[\s\S]*?\(([^)]*)\)/)
  const defaultEfforts = defined ? quotedLevels(defined[1] ?? '') : []
  const namedEfforts = new Map<string, Array<string>>()
  for (const match of prose.matchAll(
    /([A-Za-z0-9][A-Za-z0-9. +-]{2,80}?) accepts only ((?:`?"[a-z0-9]+"`?(?:, | and )?)+) for `reasoning_effort`/g,
  )) {
    const name = match[1]?.trim()
    const levels = quotedLevels(match[2] ?? '')
    if (name && levels.length > 0) namedEfforts.set(name, levels)
  }
  const out = new Map<string, ModelReasoning>()
  for (const cells of markdownTableRows(
    section(markdown, 'Supported models'),
  )) {
    const name = clean(cells[0] ?? '')
    const id = modelId(cells[1] ?? '')
    const type = clean(cells[2] ?? '')
    if (!id || !name || name === 'Model') continue
    const levels = namedEfforts.get(name)
    if (/^hybrid\b/i.test(type) && levels && levels.length > 0) {
      out.set(id, { mode: 'effort', mandatory: false, efforts: levels })
    } else if (/^hybrid\b/i.test(type)) {
      out.set(id, { mode: 'toggle', mandatory: false })
    } else if (/adjustable effort/i.test(type) && defaultEfforts.length > 0) {
      out.set(id, {
        mode: 'effort',
        mandatory: null,
        efforts: levels ?? defaultEfforts,
      })
    }
  }
  return out
}

/** An explicit own-host family contract binds only native catalog family names. */
export function parseTogetherGptOssFamily(
  markdown: string,
): ModelReasoning | null {
  const prose = stripFences(markdown)
  if (
    !/^GPT-OSS models support a `reasoning_effort` parameter that controls how much computation the model spends on reasoning\./m.test(
      prose,
    )
  )
    return null
  const definition = prose.match(
    /^\* \*\*Adjustable effort:\*\* Supports the `reasoning_effort` parameter to control reasoning depth \(([^)]*)\)\./m,
  )
  const efforts = definition ? quotedLevels(definition[1] ?? '') : []
  if (!efforts.length)
    throw new Error('together: native GPT-OSS effort values missing')
  return { mode: 'effort', mandatory: null, efforts }
}

export function togetherGptOssFamilyMatches(
  displayName: string | null,
): boolean {
  return (
    typeof displayName === 'string' &&
    /^(?:OpenAI )?GPT-OSS \d+B$/i.test(displayName)
  )
}

/** Additional dedicated controls require a named native operational disable contract. */
export function parseTogetherNamedHybrid(
  markdown: string,
): { nativeBasename: string; reasoning: ModelReasoning } | null {
  const prose = stripFences(markdown)
  const supported = prose.match(
    /^Additional reasoning models,[^\n]* and (DeepSeek V[\d.]+) \(hybrid\), are available for \[dedicated model inference\]/m,
  )?.[1]
  if (!supported) return null
  const operational = prose.match(
    /^\s*For (DeepSeek V[\d.]+), function calling only works in non-reasoning mode \(`reasoning=\{"enabled": False\}`\)\./m,
  )?.[1]
  if (
    operational !== supported ||
    !/^\* \*\*Hybrid:\*\* Supports both reasoning and non-reasoning modes via `reasoning=\{"enabled": True\/False\}`\./m.test(
      prose,
    )
  )
    throw new Error('together: named hybrid enable/disable contract missing')
  return {
    nativeBasename: supported.replace(' ', '-'),
    reasoning: { mode: 'toggle', mandatory: false },
  }
}
export function togetherNamedHybridMatches(
  rawId: string,
  nativeBasename: string,
): boolean {
  return rawId === 'deepseek-ai/' + nativeBasename
}

export function parseTogetherFamilyThinking(markdown: string): {
  effort: ThinkingRequest | null
  hybrid: ThinkingRequest | null
} {
  const prose = stripFences(markdown)
  const gpt = parseTogetherGptOssFamily(markdown)
  const effortField = prose.match(
    /^GPT-OSS models support a `([a-z_]+)` parameter/m,
  )?.[1]
  const high = gpt?.efforts?.find((value) => value === 'high')
  const hybrid = parseTogetherNamedHybrid(markdown)
  const hybridWire = prose.match(
    /^\* \*\*Hybrid:\*\* Supports both reasoning and non-reasoning modes via `([a-z_]+)=\{"([a-z_]+)": (True)\/(False)\}`\./m,
  )
  return {
    effort:
      gpt && effortField && high
        ? { on: { [effortField]: high }, off: null, levels: null }
        : null,
    hybrid:
      hybrid && hybridWire?.[1] && hybridWire[2]
        ? {
            on: {
              [hybridWire[1]]: { [hybridWire[2]]: hybridWire[3] === 'True' },
            },
            off: {
              [hybridWire[1]]: { [hybridWire[2]]: hybridWire[4] === 'True' },
            },
            levels: null,
          }
        : null,
  }
}

/**
 * One quickstart page. A single `The model ID is` wins. Otherwise only
 * model ids in that page's effort section are used, so a sibling variant
 * named in the intro does not inherit the flagship's levels.
 */
export function parseTogetherQuickstartReasoning(
  markdown: string,
): Map<string, ModelReasoning> {
  const prose = stripFences(markdown)
  let efforts: Array<string> | null = null
  for (const cells of markdownTableRows(prose)) {
    if (clean(cells[0] ?? '') !== 'reasoning_effort') continue
    const levels = quotedLevels(cells.slice(1).join(' '))
    if (levels.length > 0) efforts = levels
  }
  if (!efforts) {
    const accepts = prose.match(/`reasoning_effort` accepts ([^.\n]+)/)
    const levels = quotedLevels(accepts?.[1] ?? '')
    if (levels.length > 0) efforts = levels
  }
  const named = prose.match(/The model ID is `([^`]+)`/)
  const ids = named?.[1]?.includes('/')
    ? [named[1]]
    : quickstartSectionIds(markdown)
  const out = new Map<string, ModelReasoning>()
  if (!efforts || efforts.length === 0 || ids.length === 0) return out
  const mandatory = /cannot be disabled/i.test(prose)
    ? true
    : /disables thinking/i.test(prose)
      ? false
      : null
  for (const id of ids) {
    out.set(id, { mode: 'effort', mandatory, efforts })
  }
  return out
}

function quickstartSectionIds(markdown: string): Array<string> {
  const block =
    section(markdown, 'Set the reasoning effort') ||
    section(markdown, 'Set the thinking effort') ||
    section(markdown, 'Reasoning effort')
  const ids = new Set<string>()
  for (const match of block.matchAll(/model[=:]\s*["']([^"']+)["']/g)) {
    const id = match[1]
    if (id?.includes('/')) ids.add(id)
  }
  return [...ids]
}

async function readDoc(
  url: string,
): Promise<{ markdown: string; hash: string }> {
  const markdown = await fetchText(url, { headers: DOC_HEADERS })
  return { markdown, hash: await sha256Text(markdown) }
}

export async function loadTogetherServerlessChat(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
): Promise<TogetherDocsBundle> {
  // `#serverless-chat` keeps this shape off the media parser's cache entry.
  return cached(kv, `${TOGETHER_MODELS_DOCS_URL}#serverless-chat`, async () => {
    const { markdown, hash } = await readDoc(TOGETHER_MODELS_DOCS_URL)
    const chat = parseTogetherChatCatalog(markdown)
    assertParsed(chat, 'together serverless chat catalog')
    // Records, not Maps: cachedDocs stores JSON, and a Map serialises to {}.
    return {
      chat: Object.fromEntries(chat),
      vision: Object.fromEntries(parseTogetherVisionModalities(markdown)),
      hash,
      extractedAt: new Date().toISOString(),
    }
  })
}

export async function loadTogetherReasoningPage(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
): Promise<{
  byId: Record<string, ModelReasoning>
  gptOssFamily: ModelReasoning | null
  namedHybrid: ReturnType<typeof parseTogetherNamedHybrid>
  familyThinking: ReturnType<typeof parseTogetherFamilyThinking>
  hash: string
}> {
  return cached(kv, `${TOGETHER_REASONING_URL}#named-families-v1`, async () => {
    const { markdown, hash } = await readDoc(TOGETHER_REASONING_URL)
    const parsed = parseTogetherReasoning(markdown)
    assertParsed(parsed, 'together reasoning guide')
    // Records, not Maps: cachedDocs stores JSON, and a Map serialises to {}.
    return {
      byId: Object.fromEntries(parsed),
      gptOssFamily: parseTogetherGptOssFamily(markdown),
      namedHybrid: parseTogetherNamedHybrid(markdown),
      familyThinking: parseTogetherFamilyThinking(markdown),
      hash,
    }
  })
}

export async function loadTogetherQuickstart(
  kv: KVNamespace | undefined,
  cached: typeof cachedDocs,
  url: string,
): Promise<{ byId: Record<string, ModelReasoning>; hash: string }> {
  return cached(kv, url, async () => {
    const { markdown, hash } = await readDoc(url)
    const parsed = parseTogetherQuickstartReasoning(markdown)
    assertParsed(parsed, url)
    return { byId: Object.fromEntries(parsed), hash }
  })
}

function docsSource(url: string, hash: string, path: string): FactSource {
  return { derivation: 'docs-derived', sourceUrl: url, sourceHash: hash, path }
}

function unionFlag(
  capabilities: Array<string> | null,
  flag: string,
): Array<string> {
  if (capabilities?.includes(flag)) return capabilities
  return [...(capabilities ?? []), flag]
}

function positiveRates(row: TogetherChatRow): Record<string, number> {
  const rates: Record<string, number> = {}
  if (row.inputPerMillion != null)
    rates.input_tokens = row.inputPerMillion / 1e6
  if (row.outputPerMillion != null) {
    rates.output_tokens = row.outputPerMillion / 1e6
  }
  if (row.cachedPerMillion != null) {
    rates.cache_read_tokens = row.cachedPerMillion / 1e6
  }
  return rates
}

/**
 * Fill only facts the listing left empty. A docs outage marks those facts
 * unavailable so a stored docs value is kept. Listing numbers are not touched.
 */
export function applyTogetherDocs(
  model: ModelInfo,
  chat: TogetherDocsBundle | null,
  reasoning: Map<string, TogetherReasoningHit> | null,
  reasoningPage: { loaded: boolean; hash: string } | null,
): ModelInfo {
  const next: ModelInfo = {
    ...model,
    factSources: { ...(model.factSources ?? {}) },
  }
  const sources: ModelFactSources = next.factSources ?? {}
  const absent = { ...(model.absent ?? {}) }
  const chatRow = chat?.chat[model.rawId]
  if (model.contextWindow == null) {
    if (chatRow?.contextWindow != null && chat) {
      next.contextWindow = chatRow.contextWindow
      sources.contextWindow = docsSource(
        TOGETHER_MODELS_DOCS_URL,
        chat.hash,
        'Chat models',
      )
    } else if (!chat && model.activity === 'chat') {
      absent.contextWindow = 'unavailable'
    }
  }
  if (next.pricing == null && model.activity === 'chat') {
    if (
      chat &&
      chatRow != null &&
      chatRow.inputPerMillion != null &&
      chatRow.outputPerMillion != null
    ) {
      const card = compileTokenCard(positiveRates(chatRow), [], {
        url: TOGETHER_MODELS_DOCS_URL,
        hash: chat.hash,
        extractedAt: chat.extractedAt,
      })
      if (card) {
        next.pricing = card
        sources.pricing = docsSource(
          TOGETHER_MODELS_DOCS_URL,
          chat.hash,
          'Chat models',
        )
      }
    } else if (!chat) {
      absent.pricing = 'unavailable'
    }
  }
  if (next.modalities == null) {
    if (chat && model.rawId in chat.vision) {
      next.modalities = chat.vision[model.rawId]
      sources.modalities = docsSource(
        TOGETHER_MODELS_DOCS_URL,
        chat.hash,
        'Vision models',
      )
    } else if (!chat && model.activity === 'chat') {
      absent.modalities = 'unavailable'
    }
  }
  const hit = reasoning?.get(model.rawId)
  if (hit) {
    if (
      next.unsupportedCapabilities?.includes('reasoning') ||
      (isCapabilityMap(next.capabilities) &&
        next.capabilities.reasoning === false)
    )
      throw new Error(
        'together: native controls contradict existing explicit reasoning rejection',
      )
    next.reasoning = hit.reasoning
    sources.reasoning = docsSource(hit.sourceUrl, hit.sourceHash, 'reasoning')
    if ('thinking' in hit) {
      next.requestMap = {
        ...(next.requestMap ?? {
          thinking: null,
          maxTokensField: null,
          developerRole: null,
          replayReasoningContent: null,
          store: null,
          strictTools: null,
          sessionAffinity: null,
          cacheControl: null,
          toolStream: null,
          reasoningEffort: null,
        }),
        thinking: hit.thinking ?? null,
      }
      sources.requestMapFields = {
        ...sources.requestMapFields,
        thinking: docsSource(
          hit.sourceUrl,
          hit.sourceHash,
          'native named-family caller control declaration',
        ),
      }
    }
    const flags = Array.isArray(next.capabilities)
      ? next.capabilities.filter(
          (flag): flag is string => typeof flag === 'string',
        )
      : null
    next.capabilities = isCapabilityMap(next.capabilities)
      ? { ...next.capabilities, reasoning: true }
      : unionFlag(flags, 'reasoning')
    sources.capabilities = {
      ...(sources.capabilities ?? {}),
      reasoning: docsSource(hit.sourceUrl, hit.sourceHash, 'reasoning'),
    }
  } else if (!reasoningPage?.loaded && model.activity === 'chat') {
    absent.reasoning = 'unavailable'
  } else if (
    reasoningPage?.loaded &&
    Array.isArray(next.capabilities) &&
    next.capabilities.includes('reasoning')
  ) {
    sources.reasoning = docsSource(
      TOGETHER_REASONING_URL,
      reasoningPage.hash,
      'silent',
    )
  }
  if (Object.keys(absent).length > 0) next.absent = absent
  else delete next.absent
  if (Object.keys(sources).length === 0) delete next.factSources
  else next.factSources = sources
  return next
}

export function reasoningHit(
  reasoning: ModelReasoning,
  sourceUrl: string,
  sourceHash: string,
  thinking?: ThinkingRequest | null,
): TogetherReasoningHit {
  return {
    reasoning,
    sourceUrl,
    sourceHash,
    ...(thinking !== undefined ? { thinking } : {}),
  }
}

const TOGETHER_SUPPORTED_URL = 'https://api.together.ai/v2/supported-models'

/** Supported-models is a listing. `tagDocsFacts` stamps docs-derived; restamp it. */
export function supportedFactSources(
  facts: Pick<ModelInfo, 'modalities' | 'capabilities'>,
): ModelFactSources {
  const tagged = tagDocsFacts(facts, TOGETHER_SUPPORTED_URL)
  const asListing = (source: FactSource): FactSource => ({
    ...source,
    derivation: 'listing',
  })
  const capabilities = tagged.capabilities
    ? Object.fromEntries(
        Object.entries(tagged.capabilities).map(([flag, source]) => [
          flag,
          asListing(source),
        ]),
      )
    : undefined
  return {
    ...(tagged.modalities ? { modalities: asListing(tagged.modalities) } : {}),
    ...(capabilities ? { capabilities } : {}),
  }
}
