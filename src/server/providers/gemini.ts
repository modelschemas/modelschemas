/**
 * Google Gemini — pulls the Generative Language API Discovery doc and
 * converts it to OpenAPI 3.0. The converter is intentionally minimal
 * (ported from PR #622): it covers the Discovery subset Google's gen-AI API
 * actually uses, not general-purpose conversion.
 */
import type { Activity } from '#/db/schema.ts'
import {
  GEMINI_RELEASE_DATES,
  curatedReleasedAt,
  geminiIdSuffixDate,
} from './release-dates.ts'
import { fetchJson, fetchText, sha256Text, skippedResult } from './types.ts'
import type {
  ListModelsResult,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

const GEMINI_DISCOVERY_URL =
  'https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta'
const GEMINI_MODELS_URL =
  'https://generativelanguage.googleapis.com/v1beta/models'

interface DiscoverySchema {
  id?: string
  type?: string
  format?: string
  description?: string
  properties?: Record<string, DiscoverySchema>
  items?: DiscoverySchema
  $ref?: string
  enum?: Array<string>
  required?: Array<string>
  additionalProperties?: DiscoverySchema | boolean
}

interface DiscoveryParameter {
  type?: string
  description?: string
  location?: 'query' | 'path' | 'header'
  required?: boolean
  enum?: Array<string>
}

interface DiscoveryMethod {
  id: string
  path?: string
  flatPath?: string
  httpMethod?: string
  description?: string
  parameters?: Record<string, DiscoveryParameter>
  request?: { $ref?: string }
  response?: { $ref?: string }
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>
  resources?: Record<string, DiscoveryResource>
}

export interface DiscoveryDoc {
  rootUrl?: string
  servicePath?: string
  baseUrl?: string
  schemas?: Record<string, DiscoverySchema>
  resources?: Record<string, DiscoveryResource>
  title?: string
  version?: string
}

type JsonSchema = Record<string, unknown>

function convertSchema(schema: DiscoverySchema): JsonSchema {
  if (schema.$ref) {
    return { $ref: `#/components/schemas/${schema.$ref}` }
  }
  const out: JsonSchema = {}
  if (schema.type) out.type = schema.type
  if (schema.format) out.format = schema.format
  if (schema.description) out.description = schema.description
  if (schema.enum) out.enum = schema.enum
  if (schema.required) out.required = schema.required
  if (schema.items) out.items = convertSchema(schema.items)
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [
        name,
        convertSchema(value),
      ]),
    )
  }
  if (schema.additionalProperties !== undefined) {
    out.additionalProperties =
      typeof schema.additionalProperties === 'boolean'
        ? schema.additionalProperties
        : convertSchema(schema.additionalProperties)
  }
  return out
}

function collectMethods(
  resources: Record<string, DiscoveryResource> | undefined,
  acc: Array<DiscoveryMethod>,
): void {
  if (!resources) return
  for (const resource of Object.values(resources)) {
    if (resource.methods) {
      for (const method of Object.values(resource.methods)) {
        acc.push(method)
      }
    }
    collectMethods(resource.resources, acc)
  }
}

export function discoveryToOpenApi(doc: DiscoveryDoc): OpenApiDocument {
  const schemas = Object.fromEntries(
    Object.entries(doc.schemas ?? {}).map(([name, schema]) => [
      name,
      convertSchema(schema),
    ]),
  )

  const paths: NonNullable<OpenApiDocument['paths']> = {}
  const methods: Array<DiscoveryMethod> = []
  collectMethods(doc.resources, methods)

  for (const method of methods) {
    const path = `/${(method.flatPath ?? method.path ?? '').replace(/^\/+/, '')}`
    const httpMethod = (method.httpMethod ?? 'GET').toLowerCase()
    paths[path] ??= {}

    const operation: Record<string, unknown> = {
      operationId: method.id,
      description: method.description,
      parameters: Object.entries(method.parameters ?? {}).map(
        ([name, param]) => ({
          name,
          in: param.location ?? 'query',
          required: param.required ?? (param.location ?? 'query') === 'path',
          schema: { type: param.type, enum: param.enum },
          description: param.description,
        }),
      ),
      responses: {
        '200': {
          description: 'Success',
          content: method.response?.$ref
            ? {
                'application/json': {
                  schema: {
                    $ref: `#/components/schemas/${method.response.$ref}`,
                  },
                },
              }
            : undefined,
        },
      },
    }
    if (method.request?.$ref) {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${method.request.$ref}` },
          },
        },
      }
    }
    paths[path][httpMethod] = operation
  }

  const serverUrl =
    doc.baseUrl ??
    (doc.rootUrl && doc.servicePath
      ? `${doc.rootUrl.replace(/\/$/, '')}/${doc.servicePath.replace(/^\//, '')}`
      : 'https://generativelanguage.googleapis.com/')

  return {
    openapi: '3.0.4',
    info: {
      title: doc.title ?? 'Google Generative Language API',
      version: doc.version ?? 'v1beta',
    },
    servers: [{ url: serverUrl.replace(/\/$/, '') }],
    paths,
    components: { schemas },
  }
}

/**
 * Gemini paths encode the operation as a `:method` suffix
 * (`v1beta/models/{modelsId}:generateContent`); classify by that verb.
 * Imagen runs through `:predict`, Veo through `:predictLongRunning`.
 * Tuning management, cached contents, corpora, files, and batch job
 * submission are platform endpoints.
 */
const GEMINI_VERB_ACTIVITIES: Record<string, Activity> = {
  generateContent: 'chat',
  streamGenerateContent: 'chat',
  generateAnswer: 'chat',
  generateMessage: 'chat',
  generateText: 'chat',
  countTokens: 'chat',
  countMessageTokens: 'chat',
  countTextTokens: 'chat',
  embedContent: 'embeddings',
  batchEmbedContents: 'embeddings',
  embedText: 'embeddings',
  batchEmbedText: 'embeddings',
  predict: 'image',
  predictLongRunning: 'video',
}

function classify(path: string): Activity | null {
  const verb = path.match(/:([A-Za-z]+)$/)?.[1]
  if (!verb) return null
  return GEMINI_VERB_ACTIVITIES[verb] ?? null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const text = await fetchText(GEMINI_DISCOVERY_URL)
  const discovery = JSON.parse(text) as DiscoveryDoc
  return {
    specs: [discoveryToOpenApi(discovery)],
    sources: [{ url: GEMINI_DISCOVERY_URL, hash: await sha256Text(text) }],
    outputStrategy: 'post-200',
  }
}

interface GeminiModelList {
  models?: Array<{
    name: string
    displayName?: string
    inputTokenLimit?: number
    outputTokenLimit?: number
    supportedGenerationMethods?: Array<string>
  }>
  nextPageToken?: string
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.GEMINI_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('gemini', 'GEMINI_API_KEY') }
  }
  const models: ListModelsResult['models'] = []
  let pageToken: string | undefined
  do {
    const url = new URL(GEMINI_MODELS_URL)
    url.searchParams.set('key', key)
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const body = (await fetchJson(url.toString())) as GeminiModelList
    for (const m of body.models ?? []) {
      const rawId = m.name.replace(/^models\//, '')
      models.push({
        rawId,
        displayName: m.displayName ?? null,
        contextWindow: m.inputTokenLimit ?? null,
        maxOutput: m.outputTokenLimit ?? null,
        capabilities: m.supportedGenerationMethods,
        // Gemini's API has no release timestamp: curated dates first, then
        // the MM-YYYY month embedded in preview ids.
        releasedAt:
          curatedReleasedAt(GEMINI_RELEASE_DATES, rawId) ??
          geminiIdSuffixDate(rawId),
      })
    }
    pageToken = body.nextPageToken
  } while (pageToken)
  return { models }
}

export const geminiProvider: ProviderConfig = {
  id: 'gemini',
  displayName: 'Google Gemini',
  authEnvVar: 'GEMINI_API_KEY',
  fetchSpec,
  listModels,
  classify,
}
