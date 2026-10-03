/**
 * Provider aliases callers send in place of the dated catalog id (issue #112).
 * Anthropic publishes the alias on the models overview and each model page.
 * An alias is attached only when that page names it and the dated id is in
 * the provider listing. Retired ids, and any candidate the listing omits,
 * stay absent.
 */
import type { ModelInfo } from './types.ts'
import { fetchText, sha256Text } from './types.ts'
import {
  assertParsed,
  cachedDocs,
  mapConcurrent,
  markdownSection,
  markdownTableRows,
} from './model-facts.ts'

export const ANTHROPIC_MODELS_OVERVIEW_URL =
  'https://platform.claude.com/docs/en/about-claude/models/overview.md'

const MODEL_PAGE =
  /https:\/\/platform\.claude\.com\/docs\/en\/models\/([a-z0-9-]+)\/overview(?:\.md)?/g

/**
 * models.dev ids from issue #112 that are not Anthropic aliases. They are
 * catalog rows only when the provider listing still contains that exact id.
 */
export const UNDOCUMENTED_CANDIDATE_IDS = [
  'mistral-large-2411',
  'mistral-medium-2508',
  'mistral-small-2506',
  'devstral-latest',
  'devstral-2512',
  'pixtral-large-latest',
  'open-mistral-nemo',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'groq/compound',
  'groq/compound-mini',
  'gpt-5.3-codex-spark',
] as const

/** Candidates that appear verbatim in the provider's served model listing. */
export function candidatesStillListed(
  candidates: readonly string[],
  listedRawIds: ReadonlySet<string>,
): Array<string> {
  return candidates.filter((id) => listedRawIds.has(id))
}

function plainLabel(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
}

function codeId(cell: string | undefined): string | null {
  const id = cell?.match(/`([^`\s]+)`/)?.[1]
  return id && id.length > 0 ? id : null
}

/** `claude-opus-4-5-20251101` → `opus-4-5`. Dateless ids return null. */
export function claudeModelSlug(apiModelName: string): string | null {
  const dated = apiModelName.match(/^claude-(.+)-(\d{8})$/)
  return dated?.[1] ?? null
}

/**
 * Model-page URLs from the overview's own links, plus a page per dated id
 * the deprecations table (linked from the overview) still calls active,
 * legacy, or deprecated. Retired rows are not fetched.
 */
export function claudeModelPageUrls(
  overviewMarkdown: string,
  deprecationsMarkdown: string,
): Array<string> {
  const urls = new Set<string>()
  for (const match of overviewMarkdown.matchAll(MODEL_PAGE)) {
    const slug = match[1]
    if (slug) {
      urls.add(`https://platform.claude.com/docs/en/models/${slug}/overview.md`)
    }
  }
  for (const cells of markdownTableRows(
    markdownSection(deprecationsMarkdown, 'Model status'),
  )) {
    const name = plainLabel(cells[0] ?? '')
    const state = plainLabel(cells[1] ?? '')
    if (state === 'retired' || state === 'current state') continue
    const slug = claudeModelSlug(name)
    if (!slug) continue
    urls.add(`https://platform.claude.com/docs/en/models/${slug}/overview.md`)
  }
  return [...urls]
}

/** Wide comparison table: "Claude API ID" row vs "Claude API alias" row. */
export function parseOverviewAliases(markdown: string): Map<string, string> {
  const out = new Map<string, string>()
  let ids: Array<string | null> | null = null
  let aliases: Array<string | null> | null = null
  for (const cells of markdownTableRows(markdown)) {
    const label = plainLabel(cells[0] ?? '')
    if (label === 'claude api id')
      ids = cells.slice(1).map((cell) => codeId(cell))
    if (label === 'claude api alias') {
      aliases = cells.slice(1).map((cell) => codeId(cell))
    }
  }
  if (!ids || !aliases) return out
  for (let i = 0; i < Math.min(ids.length, aliases.length); i++) {
    const canonical = ids[i]
    const alias = aliases[i]
    if (!canonical || !alias || alias === canonical) continue
    out.set(alias, canonical)
  }
  return out
}

/** Two-column Model IDs table. Retired pages contribute nothing. */
export function parseModelAliasPage(markdown: string): {
  alias: string
  canonical: string
} | null {
  let canonical: string | null = null
  let alias: string | null = null
  let retired = false
  for (const cells of markdownTableRows(markdown)) {
    if (cells.length < 2) continue
    const label = plainLabel(cells[0] ?? '')
    const value = cells[1] ?? ''
    if (label === 'status' && plainLabel(value).startsWith('retired')) {
      retired = true
    }
    if (label === 'claude api') canonical = codeId(value)
    if (label === 'claude api alias') alias = codeId(value)
  }
  if (retired || !canonical || !alias || alias === canonical) return null
  return { alias, canonical }
}

/** Overview rows first; a model page replaces the overview for that alias. */
export function parseClaudeAliases(pages: Array<string>): Map<string, string> {
  const out = new Map<string, string>()
  const pagePairs: Array<{ alias: string; canonical: string }> = []
  for (const page of pages) {
    const pair = parseModelAliasPage(page)
    if (pair) pagePairs.push(pair)
    else {
      for (const [alias, canonical] of parseOverviewAliases(page)) {
        out.set(alias, canonical)
      }
    }
  }
  for (const pair of pagePairs) out.set(pair.alias, pair.canonical)
  return out
}

/**
 * Copy documented aliases onto the dated listing row. An alias whose dated
 * id is not listed (retired, or never served) is dropped. An alias that is
 * itself a listed id is left as its own row.
 */
export function applyDocumentedAliases<T extends ModelInfo>(
  models: Array<T>,
  aliasToCanonical: ReadonlyMap<string, string>,
): Array<T> {
  const listed = new Set(models.map((model) => model.rawId))
  const byCanonical = new Map<string, Array<string>>()
  for (const [alias, canonical] of aliasToCanonical) {
    if (alias === canonical) continue
    if (!listed.has(canonical) || listed.has(alias)) continue
    const found = byCanonical.get(canonical) ?? []
    found.push(alias)
    byCanonical.set(canonical, found)
  }
  return models.map((model) => {
    const aliases = byCanonical.get(model.rawId)
    if (!aliases || aliases.length === 0) return model
    return { ...model, aliases: [...aliases].sort() }
  })
}

/**
 * Resolve a caller id to the catalog row. A listed raw id wins. An alias
 * resolves only when exactly one listed row carries it. Anything else,
 * including a retired id, is null.
 */
/** JSON column → sorted alias ids, or null when the row has none. */
export function storedAliases(value: unknown): Array<string> | null {
  if (!Array.isArray(value)) return null
  const ids = value.filter((item): item is string => typeof item === 'string')
  return ids.length > 0 ? [...ids].sort() : null
}

export function resolveAlias<
  T extends { rawId: string; aliases?: readonly string[] | null },
>(requestedId: string, models: readonly T[]): T | null {
  const direct = models.find((model) => model.rawId === requestedId)
  if (direct) return direct
  const via = models.filter((model) =>
    (model.aliases ?? []).includes(requestedId),
  )
  return via.length === 1 ? (via[0] ?? null) : null
}

function deprecationsUrl(overview: string): string | null {
  const match = overview.match(
    /https:\/\/platform\.claude\.com\/docs\/en\/about-claude\/model-deprecations(?:\.md)?/,
  )
  if (!match) return null
  return match[0].endsWith('.md') ? match[0] : `${match[0]}.md`
}

async function fetchOptional(url: string): Promise<string | null> {
  const response = await fetch(url)
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(
      `fetch failed: ${url} → ${String(response.status)} ${response.statusText}`,
    )
  }
  return response.text()
}

/** Alias → dated id, from the models overview and the pages it points at. */
export async function anthropicAliasMap(
  kv?: KVNamespace,
): Promise<Map<string, string>> {
  const doc = await cachedDocs(kv, ANTHROPIC_MODELS_OVERVIEW_URL, async () => {
    const overview = await fetchText(ANTHROPIC_MODELS_OVERVIEW_URL)
    const depUrl = deprecationsUrl(overview)
    const deprecations = depUrl ? await fetchText(depUrl) : ''
    const urls = claudeModelPageUrls(overview, deprecations)
    const fetched = await mapConcurrent(urls, 4, fetchOptional)
    const pages = fetched.filter((page): page is string => page !== null)
    const aliases = parseClaudeAliases([overview, ...pages])
    assertParsed(aliases, 'anthropic models overview')
    return {
      pairs: [...aliases.entries()],
      hash: await sha256Text(overview),
    }
  })
  return new Map(doc.pairs)
}
