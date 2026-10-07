/**
 * Chat models named by Jina's public OpenAPI, re-read on every poll.
 * https://api.jina.ai/openapi.json `ChatCompletionRequest` is the only
 * chat body. `factSources` has no request-map slot; that document is the
 * source for `requestMap`.
 */
import type { ChatRequestMap } from './request-map.ts'

export interface JinaChatContract {
  /** Ids `ChatCompletionRequest.model` names (`const`, `enum`, or unions). */
  modelIds: ReadonlySet<string>
  requestMap: ChatRequestMap
}

const SCHEMA_REF = '#/components/schemas/'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaName(node: unknown): string | null {
  if (!isRecord(node)) return null
  const ref = node.$ref
  if (typeof ref !== 'string' || !ref.startsWith(SCHEMA_REF)) return null
  const name = ref.slice(SCHEMA_REF.length)
  return name.length > 0 ? name : null
}

function deref(
  schemas: Record<string, unknown>,
  node: unknown,
  depth = 0,
): unknown {
  const name = schemaName(node)
  if (name === null || depth > 8) return node
  const target = schemas[name]
  if (!isRecord(target)) return node
  return deref(schemas, target, depth + 1)
}

function mergedProperties(
  schemas: Record<string, unknown>,
  node: unknown,
  depth = 0,
): Record<string, unknown> {
  if (depth > 8) return {}
  const resolved = deref(schemas, node)
  if (!isRecord(resolved)) return {}
  const merged: Record<string, unknown> = {}
  if (isRecord(resolved.properties)) Object.assign(merged, resolved.properties)
  if (Array.isArray(resolved.allOf)) {
    for (const part of resolved.allOf) {
      Object.assign(merged, mergedProperties(schemas, part, depth + 1))
    }
  }
  return merged
}

function stringIds(
  schemas: Record<string, unknown>,
  node: unknown,
  depth = 0,
): Array<string> {
  if (depth > 8) return []
  const resolved = deref(schemas, node)
  if (!isRecord(resolved)) return []
  const ids: Array<string> = []
  if (typeof resolved.const === 'string' && resolved.const.length > 0) {
    ids.push(resolved.const)
  }
  if (Array.isArray(resolved.enum)) {
    for (const item of resolved.enum) {
      if (typeof item === 'string' && item.length > 0) ids.push(item)
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = resolved[key]
    if (!Array.isArray(branches)) continue
    for (const branch of branches) {
      ids.push(...stringIds(schemas, branch, depth + 1))
    }
  }
  return ids
}

function enumStrings(
  schemas: Record<string, unknown>,
  node: unknown,
  depth = 0,
): Array<string> | null {
  if (depth > 8) return null
  const resolved = deref(schemas, node)
  if (!isRecord(resolved)) return null
  if (Array.isArray(resolved.enum)) {
    const values = resolved.enum.filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    )
    return values.length > 0 ? values : null
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = resolved[key]
    if (!Array.isArray(branches)) continue
    const values: Array<string> = []
    for (const branch of branches) {
      const found = enumStrings(schemas, branch, depth + 1)
      if (found) values.push(...found)
    }
    if (values.length > 0) return [...new Set(values)]
  }
  return null
}

function roleValues(
  schemas: Record<string, unknown>,
  properties: Record<string, unknown>,
): Array<string> | null {
  const messages = deref(schemas, properties.messages)
  if (!isRecord(messages)) return null
  const items = deref(schemas, messages.items)
  if (!isRecord(items) || !isRecord(items.properties)) return null
  return enumStrings(schemas, items.properties.role)
}

/**
 * A listing id matches when it is a named model, or its segment after the
 * last `/` is (`jina-ai/jina-ocr-v1` is the const `jina-ocr-v1`).
 */
export function jinaChatModel(
  rawId: string,
  modelIds: ReadonlySet<string>,
): boolean {
  if (modelIds.has(rawId)) return true
  const slash = rawId.lastIndexOf('/')
  if (slash === -1) return false
  return modelIds.has(rawId.slice(slash + 1))
}

/**
 * Throws when the chat body is gone, names no model, or names both output
 * caps. A missing role enum leaves `developerRole` null. `reasoning_effort`
 * stays null when the body omits it: the operation accepts unknown fields
 * and ignores them, so absence is not a rejection.
 */
export function parseJinaChatRequest(spec: unknown): JinaChatContract {
  if (!isRecord(spec) || !isRecord(spec.components)) {
    throw new Error('jina spec: ChatCompletionRequest missing')
  }
  const schemas = spec.components.schemas
  if (!isRecord(schemas) || !isRecord(schemas.ChatCompletionRequest)) {
    throw new Error('jina spec: ChatCompletionRequest missing')
  }
  const properties = mergedProperties(schemas, schemas.ChatCompletionRequest)
  const modelIds = [...new Set(stringIds(schemas, properties.model))]
  if (modelIds.length === 0) {
    throw new Error('jina spec: ChatCompletionRequest names no model')
  }
  const hasCompletion = Object.hasOwn(properties, 'max_completion_tokens')
  const hasMaxTokens = Object.hasOwn(properties, 'max_tokens')
  if (hasCompletion && hasMaxTokens) {
    throw new Error(
      'jina spec: ChatCompletionRequest names both max_tokens and max_completion_tokens',
    )
  }
  const roles = roleValues(schemas, properties)
  const requestMap: ChatRequestMap = {
    thinking: null,
    maxTokensField: hasCompletion
      ? 'max_completion_tokens'
      : hasMaxTokens
        ? 'max_tokens'
        : null,
    developerRole: roles === null ? null : roles.includes('developer'),
    replayReasoningContent: null,
    store: null,
    strictTools: null,
    sessionAffinity: null,
    cacheControl: null,
    toolStream: null,
    reasoningEffort: Object.hasOwn(properties, 'reasoning_effort')
      ? true
      : null,
  }
  return { modelIds: new Set(modelIds), requestMap }
}
