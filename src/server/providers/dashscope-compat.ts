/**
 * OpenAI-compatible chat parameters from Model Studio's own markdown.
 * The page is one HTML table inside the doc. A zero-row parse throws.
 * A parameter whose description limits it to some models is not stamped
 * on every chat row.
 */
import type { ChatRequestMap } from './request-map.ts'
import { sha256Text } from './types.ts'

export const DASHSCOPE_COMPAT_URL =
  'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope.md'

/** Request parameters with no model restriction, and the flag they name. */
const PARAM_TO_FLAG: Record<string, string> = {
  temperature: 'temperature',
  top_p: 'top_p',
  max_tokens: 'max_tokens',
  seed: 'seed',
  stop: 'stop',
}

/**
 * A limit to some models. Bare "only" is not one: top_p says "keeps only
 * the smallest set of tokens", and tools says type is currently only
 * "function".
 */
const RESTRICTED =
  /supported only on|currently supported models|currently supported only/i

export interface DashscopeCompatFacts {
  requestMap: ChatRequestMap
  flags: Array<string>
  sourceHash: string
  scope: DashscopeCompatScope
}

/**
 * Which listing ids the compat page names. `qwenLlm` is the generic Qwen
 * line. `qwenKinds` are the Qwen-VL style names. `families` are the other
 * names (DeepSeek, Kimi, GLM, MiniMax). `deny` is a family the page says
 * does not speak this protocol (Qwen-Audio).
 */
export interface DashscopeCompatScope {
  qwenLlm: boolean
  qwenKinds: Array<string>
  families: Array<string>
  deny: Array<string>
}

/** Supported-models sentences from the compat page, checked 2026-10-08. */
export const DASHSCOPE_COMPAT_SCOPE = `Supported models: Qwen large language models (commercial and open-source editions), Qwen-VL, Qwen-Coder, Qwen-Omni, Qwen-Math, DeepSeek, Kimi, GLM, MiniMax.
Qwen-Audio does not support the OpenAI compatible protocol.`

/** The Supported models line, plus a family the page says is not compatible. */
export function parseDashscopeCompatScope(
  markdown: string,
): DashscopeCompatScope {
  const line = markdown.match(/Supported models:\s*([^\n]+)/i)?.[1] ?? ''
  const items = line
    .replace(/\.\s*$/, '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  const scope: DashscopeCompatScope = {
    qwenLlm: false,
    qwenKinds: [],
    families: [],
    deny: [],
  }
  if (/qwen-audio does not support/i.test(markdown)) scope.deny.push('audio')
  for (const item of items) {
    if (/qwen large language models/i.test(item)) {
      scope.qwenLlm = true
      continue
    }
    const words = item
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== '')
    if (words[0] === 'qwen' && words[1]) {
      scope.qwenKinds.push(words[1])
      continue
    }
    if (words[0]) scope.families.push(words[0])
  }
  return scope
}

/** True when this listing id is one of the compat page's supported models. */
export function dashscopeCompatCovers(
  rawId: string,
  scope: DashscopeCompatScope,
): boolean {
  const id = rawId.toLowerCase()
  const parts = id.split(/[^a-z0-9]+/).filter((part) => part !== '')
  if (parts[0] === 'qwen' && scope.deny.some((kind) => parts.includes(kind))) {
    return false
  }
  if (scope.qwenLlm && id.startsWith('qwen')) return true
  if (
    parts[0] === 'qwen' &&
    scope.qwenKinds.some((kind) => parts.includes(kind))
  ) {
    return true
  }
  return scope.families.some((family) => id.startsWith(family))
}

interface CompatParam {
  name: string
  description: string
}

function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\_/g, '_')
    .replace(/\\\//g, '/')
    .replace(/\s+/g, ' ')
    .trim()
}

function requestSection(markdown: string): string {
  const start = markdown.search(/request parameters/i)
  const end = markdown.search(/response parameters/i)
  if (start < 0 || end < start) {
    throw new Error(`${DASHSCOPE_COMPAT_URL}: no request-parameter section`)
  }
  return markdown.slice(start, end)
}

function parameters(section: string): Array<CompatParam> {
  const params: Array<CompatParam> = []
  for (const row of section.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const rowHtml = row[1]
    if (!rowHtml) continue
    const cells = [...rowHtml.matchAll(/<td>([\s\S]*?)<\/td>/g)].flatMap(
      (cell) => {
        const html = cell[1]
        return html == null ? [] : [cellText(html)]
      },
    )
    const raw = cells[0]
    if (!raw || cells.length < 4) continue
    const name = raw.replace(/\s*\(optional\)\s*$/i, '').trim()
    if (!name || name.toLowerCase() === 'parameter') continue
    params.push({ name, description: cells[3] ?? '' })
  }
  if (params.length === 0) {
    throw new Error(`${DASHSCOPE_COMPAT_URL}: parsed 0 request parameters`)
  }
  return params
}

function maxTokensField(names: Set<string>): ChatRequestMap['maxTokensField'] {
  const max = names.has('max_tokens')
  const completion = names.has('max_completion_tokens')
  if (max && !completion) return 'max_tokens'
  if (completion && !max) return 'max_completion_tokens'
  if (!max && !completion) {
    throw new Error(
      `${DASHSCOPE_COMPAT_URL}: request table names no max-token field`,
    )
  }
  return null
}

/** `Valid roles: system, user, assistant` → developer is not one of them. */
function developerRole(messages: string | undefined): boolean | null {
  const listed = messages?.match(/valid roles:\s*([^.]+)/i)?.[1]
  if (!listed) return null
  const roles = listed
    .split(/,| and /)
    .map((role) => role.trim().toLowerCase())
    .filter((role) => role !== '')
  if (roles.length === 0) return null
  return roles.includes('developer')
}

export async function parseDashscopeCompat(
  markdown: string,
): Promise<DashscopeCompatFacts> {
  const params = parameters(requestSection(markdown))
  const names = new Set(params.map((param) => param.name))
  const messages = params.find((param) => param.name === 'messages')
  const flags = params
    .filter(
      (param) =>
        PARAM_TO_FLAG[param.name] !== undefined &&
        !RESTRICTED.test(param.description),
    )
    .map((param) => PARAM_TO_FLAG[param.name] ?? param.name)
  return {
    requestMap: {
      thinking: null,
      maxTokensField: maxTokensField(names),
      developerRole: developerRole(messages?.description),
      replayReasoningContent: null,
      store: null,
      strictTools: null,
      sessionAffinity: null,
      cacheControl: null,
      toolStream: null,
      reasoningEffort: null,
    },
    flags,
    scope: parseDashscopeCompatScope(markdown),
    sourceHash: await sha256Text(markdown),
  }
}
