/** Model-owned Converse bindings filled from the current native AWS SDK. */
import { BEDROCK_CONVERSE_PATH } from './bedrock-cards.ts'
import {
  BEDROCK_SDK_MODEL_URL,
  bedrockConverseSpec,
} from './bedrock-sdk-spec.ts'
import type { BedrockServiceModel } from './bedrock-sdk-spec.ts'
import { tryDocs, unavailable } from './model-facts.ts'
import type { DocsRun } from './model-facts.ts'
import type { ChatRequestMap } from './request-map.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`amazon-bedrock SDK wire map: unreadable ${field}`)
  return value as Record<string, unknown>
}

function wireFacts(raw: unknown): {
  requestMap: ChatRequestMap
  path: string
} {
  const native = object(raw, 'service model') as unknown as BedrockServiceModel
  const spec = bedrockConverseSpec(native)
  const operationEntry = Object.entries(native.operations).find(
    ([, op]) => op.http.requestUri === BEDROCK_CONVERSE_PATH,
  )
  const operation = operationEntry?.[1]
  if (operation?.http.method !== 'POST')
    throw new Error('amazon-bedrock SDK wire map: Converse is not POST')
  const sourceInput = object(
    native.shapes[operation.input!.shape],
    'Smithy Converse input',
  )
  if (sourceInput.type !== 'structure' || sourceInput.document === true)
    throw new Error(
      'amazon-bedrock SDK wire map: native input is not a closed Smithy structure',
    )
  const nativeMembers = object(sourceInput.members, 'closed Smithy members')
  for (const [name, value] of Object.entries(nativeMembers)) {
    const member = object(value, `Smithy input member ${name}`)
    if (
      typeof member.shape !== 'string' ||
      (member.location !== undefined &&
        !['uri', 'header', 'querystring'].includes(String(member.location)))
    )
      throw new Error(
        `amazon-bedrock SDK wire map: unreadable Smithy member ${name}`,
      )
  }
  const schemas = object(spec.components?.schemas, 'native shapes')
  const resolve = (value: unknown): Record<string, unknown> => {
    const node = object(value, 'schema node')
    if (typeof node.$ref !== 'string') return node
    const name = node.$ref.match(/^#\/components\/schemas\/([^/]+)$/)?.[1]
    if (!name)
      throw new Error(
        'amazon-bedrock SDK wire map: unreadable native shape reference',
      )
    return object(schemas[name], name)
  }
  const input = object(schemas[operation.input!.shape], 'Converse input')
  if (input.type !== 'object')
    throw new Error(
      'amazon-bedrock SDK wire map: Converse input is not a structure',
    )
  const fields = object(input.properties, 'Converse input members')
  const messages = resolve(fields.messages)
  if (messages.type !== 'array')
    throw new Error(
      'amazon-bedrock SDK wire map: messages is not a native list',
    )
  const message = resolve(messages.items)
  if (message.type !== 'object')
    throw new Error(
      'amazon-bedrock SDK wire map: message is not a native structure',
    )
  const role = resolve(object(message.properties, 'message members').role)
  if (
    role.type !== 'string' ||
    !Array.isArray(role.enum) ||
    !role.enum.length ||
    !(role.enum as Array<unknown>).every((value) => typeof value === 'string')
  )
    throw new Error('amazon-bedrock SDK wire map: unreadable Message role enum')
  if (
    fields.reasoning_effort != null &&
    resolve(fields.reasoning_effort).type !== 'string'
  )
    throw new Error(
      'amazon-bedrock SDK wire map: unreadable top-level reasoning_effort',
    )
  return {
    path: `#/operations/${operationEntry![0]}/input`,
    requestMap: {
      thinking: null,
      maxTokensField: null,
      developerRole: (role.enum as Array<string>).includes('developer'),
      replayReasoningContent: null,
      store: null,
      strictTools: null,
      sessionAffinity: null,
      cacheControl: null,
      toolStream: null,
      reasoningEffort: fields.reasoning_effort != null,
    },
  }
}

export function parseBedrockConverseWireMap(value: unknown): ChatRequestMap {
  return wireFacts(value).requestMap
}

export async function loadBedrockConverseWireMaps(
  models: Array<ModelInfo>,
  run: DocsRun,
  kv?: KVNamespace,
): Promise<Array<ModelInfo>> {
  const bound = (model: ModelInfo) =>
    model.schemaEndpointId === 'model/{modelId}/converse'
  if (!models.some(bound)) return models
  const doc = await tryDocs(run, BEDROCK_SDK_MODEL_URL, (cached) =>
    cached(kv, `${BEDROCK_SDK_MODEL_URL}#converse-wire-map-v1`, async () => {
      const text = await fetchText(BEDROCK_SDK_MODEL_URL, {
        signal: AbortSignal.timeout(20_000),
      })
      return {
        ...wireFacts(JSON.parse(text) as unknown),
        hash: await sha256Text(text),
      }
    }),
  )
  const result = doc
    ? await tryDocs(run, BEDROCK_SDK_MODEL_URL, async () =>
        models.map((model) => {
          if (!bound(model)) return model
          const source = {
            derivation: 'generated' as const,
            sourceUrl: BEDROCK_SDK_MODEL_URL,
            sourceHash: doc.hash,
            path: doc.path,
          }
          for (const key of ['developerRole', 'reasoningEffort'] as const) {
            if (
              model.requestMap?.[key] != null &&
              model.requestMap[key] !== doc.requestMap[key]
            )
              throw new Error(
                `amazon-bedrock SDK wire map: contradicts existing native ${key}`,
              )
          }
          const fields = { ...model.factSources?.requestMapFields }
          for (const key of Object.keys(model.requestMap ?? {}) as Array<
            keyof ChatRequestMap
          >) {
            if (
              key === 'developerRole' ||
              key === 'reasoningEffort' ||
              model.requestMap?.[key] == null
            )
              continue
            const previous = fields[key] ?? model.factSources?.requestMap
            if (!previous)
              throw new Error(
                `amazon-bedrock SDK wire map: unsourced existing ${key}`,
              )
            fields[key] = previous
          }
          return {
            ...model,
            requestMap: {
              ...doc.requestMap,
              ...model.requestMap,
              developerRole: doc.requestMap.developerRole,
              reasoningEffort: doc.requestMap.reasoningEffort,
            },
            factSources: {
              ...model.factSources,
              requestMap: source,
              ...(Object.keys(fields).length
                ? { requestMapFields: fields }
                : {}),
            },
          }
        }),
      )
    : null
  if (result) return result
  return models.map((model) =>
    bound(model)
      ? {
          ...model,
          requestMap: model.requestMap ?? null,
          absent: { ...model.absent, ...unavailable('requestMap').absent },
        }
      : model,
  )
}
