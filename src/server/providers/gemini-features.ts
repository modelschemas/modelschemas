/**
 * Gemini thinking configuration and Google-hosted tools (issue #77).
 *
 * Tools: every model page (`/gemini-api/docs/models/{slug}.md.txt`) has a
 * Capabilities row of `**[Name](url)** Supported|Not supported` pairs.
 * Thinking: the generateContent thinking page has a `thinkingLevel` table
 * whose columns name Gemini 3 families, and a `thinkingBudget` table whose
 * rows name Gemini 2.5 families. Both key by family, so an id resolves to
 * the longest family it extends with a `-preview…`/`-latest`/`-NNN` suffix.
 * The page states in prose that no Gemini 3 model turns thinking fully off.
 * Modalities: the same model page has a `Supported data types` row.
 */
import {
  assertParsed,
  cachedDocs,
  mapConcurrent,
  markdownTableRows,
} from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { FactSource, ModelFactSources, ModelReasoning } from './types.ts'

export const GEMINI_MODELS_INDEX_URL =
  'https://ai.google.dev/gemini-api/docs/models.md.txt'
const GEMINI_MODEL_PAGE = (slug: string) =>
  `https://ai.google.dev/gemini-api/docs/models/${slug}.md.txt`
export const GEMINI_THINKING_URL =
  'https://ai.google.dev/gemini-api/docs/generate-content/thinking.md.txt'

/** Capabilities entry → generateContent `Tool` field. */
const TOOL_FIELDS: Record<string, string> = {
  'Code execution': 'codeExecution',
  'Computer use': 'computerUse',
  'File search': 'fileSearch',
  'Grounding with Google Maps': 'googleMaps',
  'Search grounding': 'googleSearch',
  'URL context': 'urlContext',
}

export function parseModelIndex(markdown: string): Array<string> {
  return [
    ...new Set(
      [
        ...markdown.matchAll(
          /https:\/\/ai\.google\.dev\/gemini-api\/docs\/models\/([a-z0-9.-]+)/g,
        ),
      ].flatMap((m) => (m[1] ? [m[1]] : [])),
    ),
  ]
}

/** Tool fields a model page marks Supported (including "(Preview)"). */
export function parsePageTools(markdown: string): Array<string> {
  const row = markdown
    .split('\n')
    .find((line) => line.startsWith('| Capabilities |'))
  if (!row) return []
  const out: Array<string> = []
  for (const m of row.matchAll(/\*\*\[([^\]]+)\]\([^)]*\)\*\*\s*([^*|]*)/g)) {
    const field = TOOL_FIELDS[m[1] ?? '']
    if (field && (m[2] ?? '').trim().startsWith('Supported')) out.push(field)
  }
  return out
}

/** Words a `Supported data types` cell uses → medium, in stored order. */
const MEDIA: Record<string, string> = {
  text: 'text',
  image: 'image',
  images: 'image',
  audio: 'audio',
  video: 'video',
  pdf: 'file',
}
const MEDIA_ORDER = [...new Set(Object.values(MEDIA))]

/** `Text, Image, Video, Audio, and PDF` → media, or null on any other word. */
function mediaList(cell: string): Array<string> | null {
  const found = new Set<string>()
  const items = cell
    .replace(/\([^)]*\)/g, '')
    .split(/,|\band\b/i)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
  for (const item of items) {
    const medium = MEDIA[item]
    if (!medium) return null
    found.add(medium)
  }
  return found.size > 0 ? MEDIA_ORDER.filter((m) => found.has(m)) : null
}

/**
 * A model page's `| Supported data types | **Inputs** … **Output** … |` row.
 * Null when the row is missing or either side names something that is not a
 * medium ("Text embeddings", "Video with audio"): a partial list would read
 * as the whole answer.
 */
export function parsePageModalities(
  markdown: string,
): { input: Array<string>; output: Array<string> } | null {
  const row = markdown.match(
    /^\| Supported data types \|\s*\*\*Inputs?\*\*(.*?)\*\*Outputs?\*\*(.*?)\|\s*$/m,
  )
  const input = mediaList(row?.[1] ?? '')
  const output = mediaList(row?.[2] ?? '')
  return input && output ? { input, output } : null
}

/** `Gemini 3.8 \& 3.7 Flash` → [`gemini-3.8-flash`, `gemini-3.7-flash`]. */
function familyIds(label: string): Array<string> {
  const clean = label
    .replace(/\*\*|\\/g, '')
    .replace(/^Gemini\s+/i, '')
    .trim()
  const match = clean.match(/^([\d.]+(?:\s*&\s*[\d.]+)*)\s+(.+)$/)
  const slug = (rest: string) => rest.toLowerCase().replace(/\s+/g, '-')
  if (!match?.[1] || !match[2]) return [`gemini-${slug(clean)}`]
  const tail = slug(match[2])
  return match[1].split('&').map((v) => `gemini-${v.trim()}-${tail}`)
}

/** Family id → reasoning, from both thinking tables. */
export function parseThinkingPage(
  markdown: string,
): Map<string, ModelReasoning> {
  const out = new Map<string, ModelReasoning>()
  const rows = markdownTableRows(markdown)
  const levelHeader = rows.find((row) => row[0] === 'Thinking Level')
  if (levelHeader) {
    const levelRows = rows.filter((row) =>
      /^\*\*`[a-z]+`\*\*$/.test(row[0] ?? ''),
    )
    levelHeader.forEach((label, col) => {
      if (col === 0 || label === 'Description') return
      const efforts = levelRows
        .filter((row) => /^supported/i.test(row[col] ?? ''))
        .map((row) => (row[0] ?? '').replace(/[*`]/g, ''))
      if (efforts.length === 0) return
      for (const id of familyIds(label)) {
        out.set(id, { mode: 'effort', mandatory: true, efforts })
      }
    })
  }
  for (const [model = '', , range, disable] of rows) {
    if (!/^\*\*[\d.]+ /.test(model) || !range?.includes('`')) continue
    for (const id of familyIds(model.replace(/\s*\([^)]*\)/, ''))) {
      out.set(id, { mode: 'budget', mandatory: /^N\/A/.test(disable ?? '') })
    }
  }
  return out
}

/** Longest family `rawId` is, or extends with a version suffix. */
export function familyOf(
  rawId: string,
  families: Iterable<string>,
): string | null {
  let best: string | null = null
  for (const family of families) {
    const exact = rawId === family
    const extends_ =
      rawId.startsWith(`${family}-`) &&
      /^(preview|latest|exp|\d)/.test(rawId.slice(family.length + 1))
    if ((exact || extends_) && (!best || family.length > best.length)) {
      best = family
    }
  }
  return best
}

/** Reasoning, server tools and modalities per listed id, with provenance. */
export async function geminiModelFeatures(
  rawIds: Array<string>,
  kv?: KVNamespace,
): Promise<
  (
    rawId: string,
    thinking: boolean,
  ) => {
    reasoning: ModelReasoning | null
    serverTools: Array<string> | null
    modalities: { input: Array<string>; output: Array<string> } | null
    factSources: ModelFactSources
  }
> {
  const [slugs, thinking] = await Promise.all([
    cachedDocs(kv, GEMINI_MODELS_INDEX_URL, async () => {
      const parsed = parseModelIndex(await fetchText(GEMINI_MODELS_INDEX_URL))
      if (parsed.length === 0) throw new Error('gemini models index: 0 slugs')
      return parsed
    }),
    cachedDocs(kv, GEMINI_THINKING_URL, async () => {
      const markdown = await fetchText(GEMINI_THINKING_URL)
      const parsed = parseThinkingPage(markdown)
      assertParsed(parsed, 'gemini thinking page')
      return {
        reasoning: Object.fromEntries(parsed),
        hash: await sha256Text(markdown),
      }
    }),
  ])
  const needed = [
    ...new Set(
      rawIds.flatMap((id) => {
        const slug = familyOf(id, slugs)
        return slug ? [slug] : []
      }),
    ),
  ]
  const pages = await mapConcurrent(needed, 8, async (slug) => {
    try {
      return await cachedDocs(kv, GEMINI_MODEL_PAGE(slug), async () => {
        const markdown = await fetchText(GEMINI_MODEL_PAGE(slug))
        return {
          slug,
          tools: parsePageTools(markdown),
          modalities: parsePageModalities(markdown),
          hash: await sha256Text(markdown),
        }
      })
    } catch {
      return null
    }
  })
  const tools = Object.fromEntries(
    pages.flatMap((page) => (page ? [[page.slug, page]] : [])),
  )
  return (rawId, modelThinks) => {
    const factSources: ModelFactSources = {}
    const family = modelThinks
      ? familyOf(rawId, Object.keys(thinking.reasoning))
      : null
    const reasoning = family ? (thinking.reasoning[family] ?? null) : null
    if (reasoning && family) {
      factSources.reasoning = {
        derivation: 'docs-derived',
        sourceUrl: GEMINI_THINKING_URL,
        sourceHash: thinking.hash,
        path: family,
      }
    } else if (modelThinks) {
      // The thinking tables do not name this id. Leave the object null.
      factSources.reasoning = {
        derivation: 'docs-derived',
        sourceUrl: GEMINI_THINKING_URL,
        sourceHash: thinking.hash,
        path: 'silent',
      }
    }
    const slug = familyOf(rawId, Object.keys(tools))
    const page = slug ? tools[slug] : undefined
    if (!slug || !page) {
      return { reasoning, serverTools: null, modalities: null, factSources }
    }
    const source = (path: string): FactSource => ({
      derivation: 'docs-derived',
      sourceUrl: GEMINI_MODEL_PAGE(slug),
      sourceHash: page.hash,
      path,
    })
    if (page.modalities) {
      factSources.modalities = source('Supported data types')
    }
    if (page.tools.length > 0) {
      factSources.serverTools = Object.fromEntries(
        page.tools.map((tool) => [tool, source('Capabilities')]),
      )
    }
    return {
      reasoning,
      serverTools: page.tools.length > 0 ? page.tools : null,
      modalities: page.modalities,
      factSources,
    }
  }
}
