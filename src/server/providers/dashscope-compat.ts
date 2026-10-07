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
    sourceHash: await sha256Text(markdown),
  }
}
