/** Plan-only facts. General pay-as-you-go bodies and prices are not borrowed. */
import type { ChatRequestMap, EffortLevelMap } from './request-map.ts'
import type { FactSource, ModelInfo } from './types.ts'

export interface CodingDoc {
  text: string
  url: string
  hash: string
}
export type CodingLocale = 'en' | 'zh'
const failure = (message: string): never => {
  throw new Error(`glm coding: ${message}`)
}
function source(doc: CodingDoc, path: string): FactSource {
  return {
    derivation: 'docs-derived',
    sourceUrl: doc.url,
    sourceHash: doc.hash,
    path,
  }
}
function names(text: string): string[] {
  return [
    ...new Set(
      (text.match(/GLM-[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/gi) ?? []).map((id) =>
        id.toLowerCase(),
      ),
    ),
  ]
}
export function validateCodingDoc(
  doc: CodingDoc,
  role: 'overview' | 'latest' | 'thinking',
  locale: CodingLocale,
): void {
  if (/^\s*<(?:!doctype|html)/i.test(doc.text))
    failure(`${doc.url} returned HTML`)
  const titles =
    locale === 'en'
      ? {
          overview: 'Overview',
          latest: 'How to Switch Models',
          thinking: 'Deep Thinking',
        }
      : { overview: '套餐概览', latest: '如何切换模型', thinking: '深度思考' }
  const title = doc.text.match(/^# ([^\n]+)$/m)?.[1]?.trim()
  if (title !== titles[role])
    failure(`${doc.url}: missing native ${role} document heading`)
}
function forcedModels(doc: CodingDoc, locale: CodingLocale): Set<string> {
  const lines = doc.text
    .split('\n')
    .filter((line) =>
      locale === 'en'
        ? /no longer support disabling thinking/.test(line)
        : /不再支持关闭思考/.test(line),
    )
  return new Set(lines.flatMap(names))
}
function codingEfforts(doc: CodingDoc, locale: CodingLocale) {
  const block =
    locale === 'en'
      ? doc.text.match(
          /In the Coding Plan request:\s*\n((?:[ \t]+\* .*\n)+)/,
        )?.[1]
      : doc.text.match(/在 Coding Plan 请求中[ \t]*\n((?:[ \t]+\* .*\n)+)/)?.[1]
  if (!block) return failure('missing explicit Coding Plan effort block')
  const forced = forcedModels(doc, locale)
  const rows = new Map<
    string,
    { efforts: string[]; mandatory: boolean | null; levels: EffortLevelMap }
  >()
  for (const line of block.trimEnd().split('\n')) {
    const modelEnd = locale === 'en' ? line.indexOf(',') : line.indexOf('，')
    if (modelEnd < 0) failure('unreadable effort model scope')
    const ids = names(line.slice(0, modelEnd))
    if (!ids.length) failure('effort row has no model scope')
    const clauses = line
      .slice(modelEnd + 1)
      .split(/[;；]/)
      .map((clause) => clause.trim())
      .filter(Boolean)
    const mapping = new Map<string, string>()
    const efforts = new Set<string>()
    let mandatory: boolean | null = null
    for (const clause of clauses) {
      const targetMatch =
        locale === 'en'
          ? clause.match(/(?:are|is) mapped to `([a-z]+)`\.?$/)
          : clause.match(/映射为 `([a-z]+)`$/)
      const stops =
        locale === 'en'
          ? /indicate that the model stops thinking/.test(clause)
          : /代表模型放弃思考/.test(clause)
      if (!targetMatch && !stops)
        failure(`unreadable Coding effort clause: ${clause}`)
      const input = targetMatch ? clause.slice(0, targetMatch.index) : clause
      const values = [...input.matchAll(/`([a-z]+)`/g)].map(
        (match) => match[1]!,
      )
      if (!values.length) failure('empty effort values')
      for (const value of values) {
        const target = targetMatch?.[1] ?? value
        if (mapping.has(value) && mapping.get(value) !== target)
          failure('conflicting effort mapping')
        mapping.set(value, target)
        efforts.add(value)
        if (stops && (value === 'none' || value === 'minimal'))
          mandatory = false
      }
    }
    const levels: EffortLevelMap = {
      off: mandatory === false ? (mapping.get('none') ?? null) : null,
      minimal: mapping.get('minimal') ?? null,
      low: mapping.get('low') ?? null,
      medium: mapping.get('medium') ?? null,
      high: mapping.get('high') ?? null,
      xhigh: mapping.get('xhigh') ?? null,
      max: mapping.get('max') ?? null,
    }
    for (const id of ids) {
      if (rows.has(id)) failure('duplicate Coding effort model')
      if (mandatory === false && forced.has(id))
        failure('contradictory native mandatory thinking evidence')
      rows.set(id, {
        efforts: [...efforts],
        mandatory: forced.has(id) ? true : mandatory,
        levels,
      })
    }
  }
  return rows
}

export function parseGlmCodingModels(
  docs: { overview: CodingDoc; latest: CodingDoc; thinking: CodingDoc },
  locale: CodingLocale,
): ModelInfo[] {
  for (const role of ['overview', 'latest', 'thinking'] as const)
    validateCodingDoc(docs[role], role, locale)
  const support = docs.overview.text
    .split('\n')
    .filter((line) =>
      locale === 'en'
        ? /All plans support[ *]*GLM-/i.test(line)
        : /所有套餐均支持/.test(line),
    )
  if (support.length !== 1)
    failure('missing or ambiguous supported-plan model list')
  const ids = names(support[0]!)
  if (!ids.length) failure('no native supported-plan models')
  // Scope the count to the actual tool setting, not unrelated compression fields.
  const contextLines = docs.latest.text
    .split('\n')
    .filter((line) => /Context Window Size/.test(line))
  if (contextLines.length > 1) failure('ambiguous plan context setting')
  const contextText = contextLines[0]
  const contextMatch = contextText?.match(
    /Context Window Size[^\n]*?(?:`(\d+)`|to (\d+)(?=$|\s|[.;](?:$|\s)))/,
  )
  if (contextText && !contextMatch) failure('unreadable plan context setting')
  const contextWindow = contextMatch
    ? Number(contextMatch[1] ?? contextMatch[2])
    : null
  if (
    contextWindow !== null &&
    (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)
  )
    failure('invalid plan context limit')
  const effortRows = codingEfforts(docs.thinking, locale)
  return ids.map((rawId) => {
    const effort = effortRows.get(rawId)
    const high = effort?.levels.high
    const requestMap: ChatRequestMap | null =
      effort && high
        ? {
            // This is the explicit Coding request control, not a compatibility body.
            thinking: {
              on: { reasoning_effort: high },
              off:
                effort.mandatory === false && effort.levels.off
                  ? { reasoning_effort: effort.levels.off }
                  : null,
              levels: effort.levels,
            },
            maxTokensField: null,
            developerRole: null,
            replayReasoningContent: null,
            store: null,
            strictTools: null,
            sessionAffinity: null,
            cacheControl: null,
            toolStream: null,
            reasoningEffort: true,
          }
        : null
    const mediaLine = docs.latest.text
      .split('\n')
      .find(
        (line) => names(line).includes(rawId) && /Support Images/.test(line),
      )
    // Native guide puts both model clauses on one line; scope to the named clause.
    const mediaClause = mediaLine
      ?.split(/[;；，,]|\bso\b|，因此/)
      .find((clause) => names(clause).includes(rawId))
    const textOnly = mediaClause && /text-only|文本模型/.test(mediaClause)
    const image = mediaClause && /multimodal|多模态/.test(mediaClause)
    const modalities = textOnly
      ? { input: ['text'], output: null }
      : image
        ? { input: ['image'], output: null }
        : null
    return {
      rawId,
      displayName: null,
      activity: 'chat',
      contextWindow,
      maxOutput: null,
      modalities,
      pricing: null,
      absent: { pricing: 'cleared' },
      schemaEndpointId: null,
      serverTools: null,
      reasoning: effort
        ? {
            mode: 'effort',
            mandatory: effort.mandatory,
            efforts: effort.efforts,
          }
        : null,
      capabilities: effort ? ['reasoning', 'reasoning_effort'] : null,
      requestMap,
      factSources: {
        ...(contextWindow !== null
          ? { contextWindow: source(docs.latest, 'Context Window Size') }
          : {}),
        ...(modalities
          ? { modalities: source(docs.latest, 'Support Images tool setting') }
          : {}),
        ...(effort
          ? {
              reasoning: source(
                docs.thinking,
                'Coding Plan reasoning_effort mapping',
              ),
              requestMap: source(
                docs.thinking,
                'Coding Plan reasoning_effort mapping',
              ),
              capabilities: {
                reasoning: source(
                  docs.thinking,
                  'Coding Plan reasoning_effort mapping',
                ),
                reasoning_effort: source(
                  docs.thinking,
                  'Coding Plan reasoning_effort mapping',
                ),
              },
            }
          : {}),
      },
    }
  })
}
