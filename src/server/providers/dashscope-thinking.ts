import { isCapabilityMap } from '#/lib/capabilities.ts'
/** Model Studio's own model scopes; code samples never seed the catalog. */
import { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const DASHSCOPE_THINKING_URL =
  'https://www.alibabacloud.com/help/en/model-studio/deep-thinking.md'
interface ThinkingDoc {
  models: Record<string, { hybrid: boolean }>
  replay: Array<string>
  hash: string
}
function ids(text: string): Array<string> {
  return [
    ...new Set(text.match(/\b[a-zA-Z][\w.]*(?:\/[\w.]+)?-[\w.-]+\b/g) ?? []),
  ]
}
export function parseDashscopeThinking(
  markdown: string,
): Omit<ThinkingDoc, 'hash'> {
  const scope = markdown.match(
    /^## Supported Models[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m,
  )?.[1]
  if (
    !scope ||
    !/thinking.mode only|only thinking mode|thinking-only mode|hybrid thinking mode/i.test(
      scope,
    )
  )
    throw new Error('dashscope thinking: missing native modes')
  const models: ThinkingDoc['models'] = {}
  for (const raw of scope.split('\n')) {
    const line = raw.replace(/<[^>]+>/g, '').trim()
    const colon = line.lastIndexOf(':')
    if (colon < 0) continue
    const names = ids(
      (line.slice(colon + 1).split(/\. (?=[A-Z])/)[0] ?? '').replace(
        /\[[^\]]*\]\([^)]*\)/g,
        '',
      ),
    )
    for (const id of names) {
      // The supported-model section includes thinking models whose control
      // details are absent. Their capability is still independently stated.
      const hybrid = /hybrid thinking mode/i.test(line)
      const previous = models[id]
      if (previous && previous.hybrid !== hybrid)
        throw new Error(`dashscope thinking: conflicting mode for ${id}`)
      models[id] = { hybrid }
    }
  }
  if (!Object.keys(models).length)
    throw new Error('dashscope thinking: parsed zero native model IDs')
  const replayBlock = markdown.match(
    /`preserve_thinking`This Parameter only supports ([^\n]+)/,
  )?.[1]
  if (
    !replayBlock ||
    !/client needs to provide historical assistant messages/i.test(markdown)
  )
    throw new Error('dashscope thinking: unreadable native replay scope')
  const replay = ids(replayBlock)
  if (!replay.length) throw new Error('dashscope thinking: empty replay scope')
  return { models, replay }
}
export async function dashscopeThinking(kv?: KVNamespace) {
  return cachedDocs(
    kv,
    `${DASHSCOPE_THINKING_URL}#model-thinking`,
    async () => {
      const markdown = await fetchText(DASHSCOPE_THINKING_URL)
      return {
        ...parseDashscopeThinking(markdown),
        hash: await sha256Text(markdown),
      }
    },
  )
}
export function applyDashscopeThinking(
  model: ModelInfo,
  doc: ThinkingDoc,
): ModelInfo {
  if (model.activity !== 'chat') return model
  const stated = doc.models[model.rawId]
  const replay = doc.replay.includes(model.rawId)
  if (!stated && !replay) return model
  if (replay && model.requestMap?.replayReasoningContent === false)
    throw new Error(
      'dashscope: native replay contradicts existing explicit rejection',
    )
  const nativeReasoning = !!stated
  if (
    nativeReasoning &&
    (model.unsupportedCapabilities?.includes('reasoning') ||
      (isCapabilityMap(model.capabilities) &&
        model.capabilities.reasoning === false))
  ) {
    throw new Error(
      'dashscope: native reasoning contradicts existing explicit rejection',
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
  const source = (path: string) => ({
    derivation: 'docs-derived' as const,
    sourceUrl: DASHSCOPE_THINKING_URL,
    sourceHash: doc.hash,
    path,
  })
  return {
    ...model,
    ...(stated
      ? {
          capabilities,
          ...(stated.hybrid
            ? { reasoning: { mode: 'toggle' as const, mandatory: false } }
            : {}),
        }
      : {}),
    ...(replay && model.requestMap
      ? { requestMap: { ...model.requestMap, replayReasoningContent: true } }
      : {}),
    factSources: {
      ...model.factSources,
      ...(stated
        ? {
            capabilities: {
              ...model.factSources?.capabilities,
              reasoning: source('Supported models'),
            },
            ...(stated.hybrid
              ? { reasoning: source('Supported models.Hybrid thinking mode') }
              : {}),
          }
        : {}),
      ...(replay && model.requestMap
        ? {
            requestMapFields: {
              ...model.factSources?.requestMapFields,
              replayReasoningContent: source(
                'Pass Thinking Process.preserve_thinking',
              ),
            },
          }
        : {}),
    },
  }
}
