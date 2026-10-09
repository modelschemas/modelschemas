/** Native sitemap discovery supplements incomplete per-category reference tables. */
import { cachedDocs, docsRun, mapConcurrent, tryDocs } from './model-facts.ts'
import type { DocsRun } from './model-facts.ts'
import {
  fetchNvidiaText,
  parseNvidiaInfer,
  nvidiaStatedModelIds,
} from './nvidia-openapi.ts'
import type { NvidiaIndexRow } from './nvidia-openapi.ts'
import type { DocsFailures } from './types.ts'

export const NVIDIA_SITEMAP_URL = 'https://docs.api.nvidia.com/sitemap.xml'
export function parseNvidiaInferSitemap(xml: string): string[] {
  if (!/<urlset(?:\s|>)/.test(xml) || !/<\/urlset>/.test(xml))
    throw new Error('nvidia: sitemap has no urlset')
  const urls = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].flatMap(
    (match) => {
      const url = match[1]?.trim()
      return url &&
        /^https:\/\/docs\.api\.nvidia\.com\/nim\/reference\/[a-zA-Z0-9._-]+-(?:infer|invoke)$/.test(
          url,
        )
        ? [url]
        : []
    },
  )
  if (!urls.length)
    throw new Error('nvidia: sitemap parsed no native infer URLs')
  return [...new Set(urls)]
}
const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
/** Names select candidate pages only. Structured native schema IDs perform every join. */
export function nvidiaSitemapCandidates(
  rawId: string,
  urls: string[],
): string[] {
  const model = rawId.split('/')[1]
  if (!model) return []
  return urls.filter((url) =>
    key(
      url
        .split('/')
        .at(-1)
        ?.replace(/-(infer|invoke)$/, '') ?? '',
    ).endsWith(key(model)),
  )
}
export async function discoverNvidiaSitemap(
  rawIds: string[],
  kv?: KVNamespace,
  run: DocsRun = docsRun(),
): Promise<{
  rows: NvidiaIndexRow[]
  failures: DocsFailures
  unavailable: string[]
}> {
  const rows: NvidiaIndexRow[] = []
  const unavailable = new Set<string>()
  if (!rawIds.length)
    return { rows, failures: run, unavailable: [...unavailable] }
  const urls = await tryDocs(run, NVIDIA_SITEMAP_URL, (cached) =>
    cached(kv, NVIDIA_SITEMAP_URL, async () =>
      parseNvidiaInferSitemap(await fetchNvidiaText(NVIDIA_SITEMAP_URL)),
    ),
  )
  if (urls === null) return { rows, failures: run, unavailable: rawIds }
  const wanted = new Map<string, string[]>()
  for (const rawId of rawIds)
    for (const url of nvidiaSitemapCandidates(rawId, urls))
      wanted.set(url, [...(wanted.get(url) ?? []), rawId])
  const parsed = await mapConcurrent(
    [...wanted],
    3,
    async ([inferUrl, candidates]) => {
      const page = inferUrl + '.md'
      const ids = await tryDocs(run, page, async (cached) => {
        const stated = await cached(
          kv,
          'nvidia-sitemap-binding:' + page,
          async () => {
            const markdown = await cachedDocs(kv, page, () =>
              fetchNvidiaText(page),
            )
            const infer = parseNvidiaInfer(markdown)
            if (!infer)
              throw new Error(
                'nvidia: sitemap infer page has no OpenAPI document: ' + page,
              )
            const nativeIds = nvidiaStatedModelIds(infer.document)
            if (nativeIds.length !== 1)
              throw new Error(
                'nvidia: sitemap infer page does not identify one native model: ' +
                  page,
              )
            // The binding cache stores only source-owned IDs, never URL-derived IDs.
            return nativeIds
          },
        )
        if (
          !Array.isArray(stated) ||
          stated.length !== 1 ||
          typeof stated[0] !== 'string' ||
          !candidates.includes(stated[0])
        )
          throw new Error(
            'nvidia: sitemap infer page does not identify its candidate model: ' +
              page +
              '; expected ' +
              candidates.join(', ') +
              '; stated ' +
              JSON.stringify(stated),
          )
        return stated
      })
      if (ids === null)
        for (const candidate of candidates) unavailable.add(candidate)
      return (ids ?? []).map((rawId) => ({ rawId, inferUrl }))
    },
  )
  const seen = new Set<string>()
  for (const row of parsed.flat())
    if (!seen.has(row.rawId)) {
      seen.add(row.rawId)
      rows.push(row)
    }
  return { rows, failures: run, unavailable: [...unavailable] }
}
