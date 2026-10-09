import { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelReasoning } from './types.ts'

export const GEMINI_LIVE_GUIDE_URL =
  'https://ai.google.dev/gemini-api/docs/live-guide.md.txt'
export function parseGeminiNativeAudioThinking(markdown: string): {
  rawId: string
  reasoning: ModelReasoning
} {
  const prose = markdown.replace(/```[\s\S]*?```/g, '')
  const section = prose.match(
    /^### Thinking\s*\n([\s\S]*?)(?=^### |(?![\s\S]))/m,
  )?.[1]
  const sentences =
    section?.split(/\n\s*\n/).flatMap((paragraph) =>
      paragraph
        .replace(/\s+/g, ' ')
        .trim()
        .split(/(?<=[.!?])\s+/),
    ) ?? []
  const rawId = sentences
    .map(
      (sentence) =>
        sentence.match(
          /^The latest native audio output model `([a-z0-9.-]+)` supports\b/,
        )?.[1],
    )
    .find(Boolean)
  const budget = sentences.some((sentence) =>
    /^The `thinkingBudget` parameter guides the model on the number of thinking tokens\b/.test(
      sentence,
    ),
  )
  const disable = sentences.some((sentence) =>
    /^You can disable thinking by setting `thinkingBudget` to `0`\./.test(
      sentence,
    ),
  )
  if (!rawId || !budget || !disable)
    throw new Error(
      'gemini live guide: native model/budget/disable contract unreadable',
    )
  return { rawId, reasoning: { mode: 'budget', mandatory: false } }
}
export async function geminiNativeAudioThinking(
  rawIds: ReadonlyArray<string>,
  kv?: KVNamespace,
) {
  // Names select which own guide to check; only its literal model ID binds facts.
  if (!rawIds.some((id) => id.includes('native-audio'))) return null
  return cachedDocs(kv, GEMINI_LIVE_GUIDE_URL, async () => {
    const markdown = await fetchText(GEMINI_LIVE_GUIDE_URL, {
      signal: AbortSignal.timeout(20_000),
    })
    return {
      ...parseGeminiNativeAudioThinking(markdown),
      hash: await sha256Text(markdown),
    }
  })
}
