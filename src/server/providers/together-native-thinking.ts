import { isCapabilityMap } from '#/lib/capabilities.ts'
/** Host-owned reasoning and replay evidence, independently of mode controls. */
import { cachedDocs, markdownTableRows } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ChatRequestMap } from './request-map.ts'
import type { ModelInfo } from './types.ts'

export const TOGETHER_KIMI_REPLAY_URL =
  'https://docs.together.ai/docs/kimi-k3-quickstart.md'
export const TOGETHER_DEEPSEEK_URL =
  'https://docs.together.ai/docs/deepseek-v4-quickstart.md'
export const TOGETHER_GLM_URL =
  'https://docs.together.ai/docs/glm-5.3-quickstart.md'
export const TOGETHER_NATIVE_REASONING_URL =
  'https://docs.together.ai/docs/inference/chat/reasoning.md'
interface Evidence {
  ids: Array<string>
  replay: Array<string>
  hash: string
  url: string
}
const modelsInSamples = (text: string): Array<string> => [
  ...new Set(
    [...text.matchAll(/model[=:]\s*["']([\w.+-]+\/[\w.+-]+)["']/g)].flatMap(
      (match) => (match[1] ? [match[1]] : []),
    ),
  ),
]
export function parseTogetherNativeThinking(
  markdown: string,
): Pick<Evidence, 'ids' | 'replay'> {
  const intro = markdown.split(/^## /m)[0] ?? ''
  const named = intro.match(/The model ID is `([^`]+)`/)?.[1]
  const ids = new Set<string>()
  if (named && /reasoning/i.test(intro)) ids.add(named)
  if (/Thinking is on by default/i.test(intro)) {
    for (const row of markdownTableRows(intro)) {
      if (!row[1]) continue
      const id = row[1].replace(/`/g, '').trim()
      if (/^[\w.+-]+\/[\w.+-]+$/.test(id)) ids.add(id)
    }
  }
  const replay = new Set<string>()
  const preserved =
    markdown.match(
      /^### Preserved thinking\s*\n([\s\S]*?)(?=^###? |(?![\s\S]))/m,
    )?.[1] ??
    markdown.match(
      /^## (?:Preserved thinking|Preserve thinking across turns)\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m,
    )?.[1]
  if (
    preserved &&
    /(?:include the unmodified|return the model's) `reasoning_content`/i.test(
      preserved,
    )
  ) {
    for (const id of modelsInSamples(preserved)) replay.add(id)
  }
  // This host explicitly names reasoning_content on the next request even
  // when its response uses the reasoning alias. Scope to the page's own ID.
  if (
    named &&
    /For multi-turn function calling, pass the assistant message's reasoning trace back/i.test(
      markdown,
    ) &&
    /Include the assistant message's `content`, `reasoning_content`, and `tool_calls`/i.test(
      markdown,
    )
  )
    replay.add(named)
  const history = markdown.match(
    /^## Preserve the thinking history\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m,
  )?.[1]
  if (
    named &&
    history &&
    /Return the complete assistant message on every turn, `reasoning_content` included/.test(
      history,
    ) &&
    modelsInSamples(history).includes(named)
  )
    replay.add(named)
  return { ids: [...ids], replay: [...replay] }
}
export async function togetherNativeThinking(
  kv?: KVNamespace,
): Promise<Array<Evidence>> {
  return Promise.all(
    [
      TOGETHER_DEEPSEEK_URL,
      TOGETHER_GLM_URL,
      TOGETHER_NATIVE_REASONING_URL,
      TOGETHER_KIMI_REPLAY_URL,
    ].map((url) =>
      cachedDocs(kv, `${url}#native-thinking`, async () => {
        const markdown = await fetchText(url, {
          signal: AbortSignal.timeout(20_000),
        })
        const facts = parseTogetherNativeThinking(markdown)
        if (!facts.ids.length && !facts.replay.length)
          throw new Error(
            `together native thinking: parsed no evidence from ${url}`,
          )
        return { ...facts, url, hash: await sha256Text(markdown) }
      }),
    ),
  )
}
export function applyTogetherNativeThinking(
  model: ModelInfo,
  docs: Array<Evidence>,
): ModelInfo {
  if (model.activity !== 'chat') return model
  const reason = docs.find((doc) => doc.ids.includes(model.rawId))
  const replay = docs.find((doc) => doc.replay.includes(model.rawId))
  if (!reason && !replay) return model
  if (replay && model.requestMap?.replayReasoningContent === false)
    throw new Error(
      'together: native replay contradicts existing explicit rejection',
    )
  const nativeReasoning = !!reason
  if (
    nativeReasoning &&
    (model.unsupportedCapabilities?.includes('reasoning') ||
      (isCapabilityMap(model.capabilities) &&
        model.capabilities.reasoning === false))
  ) {
    throw new Error(
      'together: native reasoning contradicts existing explicit rejection',
    )
  }
  const capabilities = isCapabilityMap(model.capabilities)
    ? { ...model.capabilities, reasoning: true }
    : [
        ...new Set([
          ...(Array.isArray(model.capabilities)
            ? (model.capabilities as Array<string>)
            : []),
          'reasoning',
        ]),
      ]
  const source = (doc: Evidence, path: string) => ({
    derivation: 'docs-derived' as const,
    sourceUrl: doc.url,
    sourceHash: doc.hash,
    path,
  })
  const map: ChatRequestMap = model.requestMap ?? {
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
  }
  return {
    ...model,
    ...(reason
      ? {
          capabilities,
        }
      : {}),
    requestMap: { ...map, ...(replay ? { replayReasoningContent: true } : {}) },
    factSources: {
      ...model.factSources,
      ...(reason
        ? {
            capabilities: {
              ...model.factSources?.capabilities,
              reasoning: source(reason, 'Native model reasoning'),
            },
          }
        : {}),
      ...(replay
        ? {
            requestMapFields: {
              ...model.factSources?.requestMapFields,
              replayReasoningContent: source(
                replay,
                'Preserved thinking / multi-turn function calling',
              ),
            },
          }
        : {}),
    },
  }
}
