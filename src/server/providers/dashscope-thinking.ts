import { isCapabilityMap } from '#/lib/capabilities.ts'
/** Model Studio's own model scopes; code samples never seed the catalog. */
import { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const DASHSCOPE_THINKING_URL =
  'https://www.alibabacloud.com/help/en/model-studio/deep-thinking.md'
interface ThinkingDoc {
  models: Record<
    string,
    { hybrid: boolean; budget?: boolean; mandatory?: boolean | null }
  >
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
  const prose = markdown.replace(/```[\s\S]*?```/g, '')
  const budgetLine = prose
    .split('\n')
    .find((line) => /`thinking_budget`[^\n]*Applicable to /.test(line))
  if (
    budgetLine &&
    /\b(?:not|never|cannot|unsupported|except)\b|\b(?:can't|don't|doesn't|isn't)\b/i.test(
      budgetLine,
    )
  )
    throw new Error('dashscope thinking: negated native budget declaration')
  const budgetScope = budgetLine?.match(
    /Applicable to ([^\n]+?) series models\./,
  )?.[1]
  if (!budgetScope)
    throw new Error('dashscope thinking: missing native thinking-budget scope')
  const budgetFamilies = budgetScope
    .split(/,|\band\b/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (
    !budgetFamilies.length ||
    budgetFamilies.some((value) => !/^[a-z0-9.-]+$/.test(value))
  )
    throw new Error('dashscope thinking: malformed native budget families')
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
    if (
      names.length &&
      /thinking.mode only|only thinking mode|thinking-only mode/i.test(line) &&
      /\b(?:not|never|no|unsupported)\b|\b(?:can't|don't|doesn't|isn't)\b/i.test(
        line,
      )
    )
      throw new Error(
        'dashscope thinking: negated native model mode declaration',
      )
    for (const id of names) {
      // The supported-model section includes thinking models whose control
      // details are absent. Their capability is still independently stated.
      const hybrid = /hybrid thinking mode/i.test(line)
      const previous = models[id]
      if (previous && previous.hybrid !== hybrid)
        throw new Error(`dashscope thinking: conflicting mode for ${id}`)
      const only =
        /thinking.mode only|only thinking mode|thinking-only mode|only thinking mode supported/i.test(
          line,
        )
      const budget = budgetFamilies.some(
        (family) =>
          id.toLowerCase() === family ||
          id.toLowerCase().startsWith(family + '-') ||
          id.toLowerCase().startsWith(family + '.') ||
          id.toLowerCase().startsWith(family + '/'),
      )
      models[id] = {
        hybrid,
        ...(budget ? { budget: true, mandatory: only ? true : null } : {}),
      }
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
            : stated.budget
              ? {
                  reasoning: {
                    mode: 'budget' as const,
                    mandatory: stated.mandatory ?? null,
                  },
                }
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
              : stated.budget
                ? {
                    reasoning: source(
                      'Supported models.Thinking-only mode; Limit Thinking Length.thinking_budget applicability',
                    ),
                  }
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
