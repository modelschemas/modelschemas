import { cachedDocs, markdownTableRows } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'

export const OPENAI_REALTIME_EFFORT_URL =
  'https://developers.openai.com/api/docs/guides/realtime-models-prompting.md'
export function parseOpenAiRealtimeEfforts(markdown: string): {
  rawId: string
  efforts: string[]
} {
  const prose = markdown.replace(/```[\s\S]*?```/g, '')
  const section = prose.match(
    /^## Set reasoning effort\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m,
  )?.[1]
  const rawId = section?.match(
    /^`([a-z0-9.-]+)` can trade latency for deeper reasoning\./m,
  )?.[1]
  const rows = markdownTableRows(section ?? '')
  const header = rows.shift()
  if (!rawId || header?.length !== 3 || header[0] !== 'Effort' || !rows.length)
    throw new Error('openai realtime effort guide: model/table unreadable')
  const efforts = rows.map((row) => {
    const level = row[0]?.match(/^`([a-z]+)`$/)?.[1]
    if (row.length !== 3 || !level || !row[1] || !row[2])
      throw new Error('openai realtime effort guide: malformed effort row')
    return level
  })
  if (new Set(efforts).size !== efforts.length)
    throw new Error('openai realtime effort guide: duplicate efforts')
  return { rawId, efforts }
}
export async function openaiRealtimeEfforts(
  rawIds: ReadonlyArray<string>,
  kv?: KVNamespace,
) {
  // Model names select an own guide; its literal model ID alone binds the result.
  if (!rawIds.some((id) => id.includes('realtime'))) return null
  return cachedDocs(kv, OPENAI_REALTIME_EFFORT_URL, async () => {
    const markdown = await fetchText(OPENAI_REALTIME_EFFORT_URL, {
      signal: AbortSignal.timeout(20_000),
    })
    return {
      ...parseOpenAiRealtimeEfforts(markdown),
      hash: await sha256Text(markdown),
    }
  })
}
