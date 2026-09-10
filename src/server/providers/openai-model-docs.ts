/**
 * OpenAI model facts from OpenAI's own docs. `GET /v1/models` is `id` +
 * `created` only; developers.openai.com serves every model page as
 * markdown (`/api/docs/models/{slug}.md`) with a fixed "Model details"
 * bullet list, a "Supported features" list, and the page's snapshot ids. The index (`/api/docs/models.md`) is the
 * slug list. Only pages the listed ids resolve to are fetched (~65 of the
 * ~130 listed ids share a page), bounded-concurrency, memoised six hours.
 */
import { tagDocsFacts } from './fact-sources.ts'
import {
  NO_FACTS,
  assertParsed,
  cachedDocs,
  mapConcurrent,
  tokenCount,
  undatedId,
} from './model-facts.ts'
import type { ModelFacts } from './model-facts.ts'
import { fetchText } from './types.ts'

export const OPENAI_MODELS_INDEX_URL =
  'https://developers.openai.com/api/docs/models.md'
const OPENAI_MODEL_PAGE = (slug: string) =>
  `https://developers.openai.com/api/docs/models/${slug}.md`

/** Page slugs linked from the models index. */
export function parseModelIndex(markdown: string): Set<string> {
  return new Set(
    [
      ...markdown.matchAll(/\]\(\/api\/docs\/models\/([^)\s]+?)\.md\)/g),
    ].flatMap((m) => (m[1] ? [m[1]] : [])),
  )
}

export interface OpenAiModelPage {
  /** Every id the page speaks for: `Model ID`, default snapshot, snapshots. */
  ids: Array<string>
  facts: ModelFacts
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}`)
  if (start < 0) return ''
  const rest = markdown.slice(start + 1)
  const end = rest.indexOf('\n## ')
  return end < 0 ? rest : rest.slice(0, end)
}

function listValues(block: string, label: string): Array<string> {
  const match = block.match(new RegExp(`^- ${label}: (.+)$`, 'm'))
  return match?.[1]
    ? match[1].split(',').map((s) => s.trim().toLowerCase())
    : []
}

/** Parse one model page's details, features and snapshot ids. */
export function parseModelPage(markdown: string): OpenAiModelPage | null {
  const modelId = markdown.match(/^Model ID: `([^`]+)`/m)?.[1]
  if (!modelId) return null
  const details = section(markdown, 'Model details')
  const ids = new Set<string>([modelId])
  const snapshot = details.match(/^- Default snapshot: `([^`]+)`/m)?.[1]
  if (snapshot) ids.add(snapshot)
  for (const m of section(markdown, 'Snapshots').matchAll(/^- `([^`]+)`/gm)) {
    if (m[1]) ids.add(m[1])
  }

  const input = listValues(details, 'Input modalities')
  const output = listValues(details, 'Output modalities')
  const contextWindow = tokenCount(
    details.match(/^- ([\d,]+) context window/m)?.[1],
  )
  const maxOutput = tokenCount(
    details.match(/^- ([\d,]+) max output tokens/m)?.[1],
  )

  const features = new Set(
    [...section(markdown, 'Supported features').matchAll(/^- (\S+)/gm)].map(
      (m) => m[1] ?? '',
    ),
  )
  const reasoning = /^- Reasoning token support/m.test(details)
  const capabilities: Array<string> = []
  if (features.has('function_calling')) capabilities.push('tools')
  if (reasoning) capabilities.push('reasoning')
  // Effort levels and sampling-param support appear only in prose on the
  // page; neither is a field, so neither is asserted here.
  if (features.has('structured_outputs')) {
    capabilities.push('structured_outputs', 'response_format')
  }

  return {
    ids: [...ids],
    facts: {
      contextWindow,
      maxOutput,
      modalities:
        input.length > 0 || output.length > 0 ? { input, output } : null,
      capabilities: capabilities.length > 0 ? capabilities : null,
    },
  }
}

/** Page slug a listed id resolves to, or null when the docs have no page. */
export function pageSlugFor(rawId: string, slugs: Set<string>): string | null {
  if (slugs.has(rawId)) return rawId
  const undated = undatedId(rawId)
  if (slugs.has(undated)) return undated
  return null
}

/**
 * Facts for the listed ids. Pages are fetched once per slug and memoised;
 * a page's snapshot list also seeds ids the index alone couldn't resolve.
 */
export async function openaiModelFacts(
  rawIds: Array<string>,
  kv?: KVNamespace,
): Promise<(rawId: string) => ModelFacts> {
  const slugs = new Set(
    await cachedDocs(kv, OPENAI_MODELS_INDEX_URL, async () => {
      const parsed = [
        ...parseModelIndex(await fetchText(OPENAI_MODELS_INDEX_URL)),
      ]
      if (parsed.length === 0) {
        throw new Error('openai models index: parsed 0 page slugs')
      }
      return parsed
    }),
  )
  const needed = [
    ...new Set(
      rawIds
        .map((id) => pageSlugFor(id, slugs))
        .filter((slug): slug is string => slug !== null),
    ),
  ]
  const pages = await mapConcurrent(needed, 8, async (slug) => {
    try {
      const page = await cachedDocs(kv, OPENAI_MODEL_PAGE(slug), async () => {
        const parsed = parseModelPage(await fetchText(OPENAI_MODEL_PAGE(slug)))
        if (!parsed) {
          throw new Error(`openai model page ${slug}: no Model ID`)
        }
        return parsed
      })
      return { slug, page }
    } catch {
      return null
    }
  })
  const byId = new Map<string, ModelFacts>()
  for (const loaded of pages) {
    if (!loaded) continue
    const facts: ModelFacts = {
      ...loaded.page.facts,
      factSources: tagDocsFacts(
        loaded.page.facts,
        OPENAI_MODEL_PAGE(loaded.slug),
      ),
    }
    for (const id of loaded.page.ids) byId.set(id, facts)
  }
  if (needed.length > 0) assertParsed(byId, 'openai model pages')
  return (rawId) => byId.get(rawId) ?? byId.get(undatedId(rawId)) ?? NO_FACTS
}
