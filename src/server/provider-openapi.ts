/**
 * Assemble a generation-only OpenAPI 3.1 document for one provider from
 * stored endpoints + current schema versions + the provider's connect
 * profile. Reuses `schema_versions` rows (no second derivation); overlays
 * the live or pinned `model` enum, and moves output onto the sibling GET
 * when `connect.siblingGet` is set.
 */
import { and, eq, isNull } from 'drizzle-orm'

import type { Db } from '#/db/index.ts'
import { activities, endpoints, schemaVersions } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import {
  getModelDetail,
  knownProviderIds,
  listModelsCatalog,
} from '#/server/catalog.ts'
import { contentHash } from '#/server/kv.ts'
import { getProvider } from '#/server/providers/index.ts'
import {
  MAX_SPEC_PATHS,
  resolveConnect,
  resolveSpecGrain,
} from '#/server/providers/connect.ts'
import type { ProviderConnect } from '#/server/providers/types.ts'
import { providerExists, publicEndpointId } from '#/server/schemas-api.ts'

export { MAX_SPEC_PATHS }

export interface AssembleOpenApiQuery {
  model?: string
  activity?: string
}

export type AssembleOpenApiResult =
  | { ok: true; document: Record<string, unknown>; etag: string }
  | { ok: false; status: 400 | 404; code: string; message: string }

interface LoadedEndpoint {
  id: string
  path: string
  activity: Activity
  description: string | null
  method: string
  input?: unknown
  output?: unknown
  specRevision: string | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `{name}` path segments → required path parameters. */
export function pathParamsFromPath(
  path: string,
): Array<Record<string, unknown>> {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
  return names
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }))
}

export function headerParams(
  headers: Record<string, string> | undefined,
): Array<Record<string, unknown>> {
  if (!headers) return []
  return Object.entries(headers).map(([name, value]) => ({
    name,
    in: 'header',
    required: true,
    schema: { type: 'string', const: value },
  }))
}

/** Pin `properties.model` to a live enum (or a single id). */
export function applyModelEnum(
  schema: unknown,
  modelIds: Array<string>,
): unknown {
  if (!isObject(schema) || modelIds.length === 0) return schema
  const props = schema.properties
  if (!isObject(props) || !isObject(props.model)) return schema
  return {
    ...schema,
    properties: {
      ...props,
      model: { ...props.model, enum: modelIds },
    },
  }
}

/** Pin common model path params (Gemini `modelsId`). */
function pinPathParams(
  parameters: Array<Record<string, unknown>>,
  modelId: string,
): Array<Record<string, unknown>> {
  return parameters.map((parameter) => {
    const name = parameter.name
    if (parameter.in !== 'path') return parameter
    if (name !== 'model' && name !== 'modelsId' && name !== 'model_id') {
      return parameter
    }
    return { ...parameter, schema: { type: 'string', enum: [modelId] } }
  })
}

function media(
  schema: unknown,
): { content: { 'application/json': { schema: unknown } } } | undefined {
  if (schema === undefined) return undefined
  return { content: { 'application/json': { schema } } }
}

function operationId(providerId: string, method: string, path: string): string {
  const slug = `${providerId}-${method}-${path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : `${providerId}-${method}`
}

export function endpointMatchesModel(
  endpointId: string,
  path: string,
  rawId: string,
): boolean {
  return endpointId === rawId || path === rawId || path === `/${rawId}`
}

function refuseSelector(
  providerId: string,
  grain: 'provider' | 'model',
  count: number,
  reason: string,
): AssembleOpenApiResult {
  const example = `GET /v1/openapi/${providerId}?model=`
  return {
    ok: false,
    status: 400,
    code: 'spec_requires_selector',
    message:
      grain === 'model'
        ? `Provider '${providerId}' is model-grained (${String(count)} endpoints) — there is no combined OpenAPI document. Pass ?model={rawId}, e.g. ${example}<rawId>. List models: GET /v1/providers/${providerId}/models.`
        : `${reason} Pass ?model={rawId} or ?activity= to narrow, e.g. ${example}<rawId>.`,
  }
}

async function loadEndpoints(
  db: Db,
  providerId: string,
  activity: Activity | undefined,
): Promise<Array<LoadedEndpoint>> {
  const rows = await db
    .select({
      id: endpoints.id,
      path: endpoints.path,
      activity: endpoints.activity,
      description: endpoints.description,
      method: endpoints.method,
      kind: schemaVersions.kind,
      schema: schemaVersions.schema,
      specRevision: schemaVersions.specRevision,
    })
    .from(endpoints)
    .leftJoin(
      schemaVersions,
      and(
        eq(schemaVersions.endpointId, endpoints.id),
        isNull(schemaVersions.supersededAt),
      ),
    )
    .where(
      activity
        ? and(
            eq(endpoints.providerId, providerId),
            eq(endpoints.activity, activity),
          )
        : eq(endpoints.providerId, providerId),
    )
    .orderBy(endpoints.id)

  const byId = new Map<string, LoadedEndpoint>()
  for (const row of rows) {
    const existing = byId.get(row.id)
    const parsed =
      row.schema !== null ? (JSON.parse(row.schema) as unknown) : undefined
    if (!existing) {
      byId.set(row.id, {
        id: publicEndpointId(row.id, providerId),
        path: row.path,
        activity: row.activity,
        description: row.description,
        method: row.method,
        specRevision: row.specRevision,
        ...(row.kind === 'input' ? { input: parsed } : {}),
        ...(row.kind === 'output' ? { output: parsed } : {}),
      })
      continue
    }
    if (row.kind === 'input') existing.input = parsed
    if (row.kind === 'output') existing.output = parsed
    if (existing.specRevision === null) existing.specRevision = row.specRevision
  }
  return [...byId.values()]
}

function buildOperation(
  providerId: string,
  endpoint: LoadedEndpoint,
  connect: ProviderConnect,
  modelIds: Array<string>,
  pinnedModel: string | undefined,
): Record<string, unknown> {
  const input = applyModelEnum(
    endpoint.input,
    pinnedModel ? [pinnedModel] : modelIds,
  )
  const parameters = [
    ...pathParamsFromPath(endpoint.path),
    ...headerParams(connect.requiredHeaders),
  ]
  const pinned = pinnedModel
    ? pinPathParams(parameters, pinnedModel)
    : parameters
  const body = media(input)
  return {
    operationId: operationId(providerId, 'post', endpoint.path),
    summary: endpoint.description ?? undefined,
    'x-modelschemas-activity': endpoint.activity,
    ...(pinned.length > 0 ? { parameters: pinned } : {}),
    ...(body ? { requestBody: { required: true, ...body } } : {}),
    responses: {
      '200': {
        description: 'Success',
        ...(connect.siblingGet ? {} : (media(endpoint.output) ?? {})),
      },
    },
  }
}

function buildSiblingGet(
  providerId: string,
  endpoint: LoadedEndpoint,
): Record<string, unknown> {
  const requestPath = `${endpoint.path}/requests/{request_id}`
  return {
    operationId: operationId(providerId, 'get', requestPath),
    summary: 'Fetch a queued request result',
    'x-modelschemas-activity': endpoint.activity,
    parameters: [
      ...pathParamsFromPath(endpoint.path),
      {
        name: 'request_id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': {
        description: 'Queued result',
        ...(media(endpoint.output) ?? {}),
      },
    },
  }
}

/**
 * Assemble GET /v1/openapi/{provider}. Refuses combined documents for
 * model-grained providers and for selections over {@link MAX_SPEC_PATHS}.
 */
export async function assembleProviderOpenApi(
  db: Db,
  providerId: string,
  query: AssembleOpenApiQuery = {},
): Promise<AssembleOpenApiResult> {
  if (!(await providerExists(db, providerId))) {
    const valid = (await knownProviderIds(db)).join(', ')
    return {
      ok: false,
      status: 404,
      code: 'unknown_provider',
      message: `Unknown provider '${providerId}'. Valid providers: ${valid}.`,
    }
  }

  let activity: Activity | undefined
  if (query.activity !== undefined) {
    if (!(activities as ReadonlyArray<string>).includes(query.activity)) {
      return {
        ok: false,
        status: 404,
        code: 'unknown_activity',
        message: `Unknown activity '${query.activity}'. Valid activities: ${activities.join(', ')}.`,
      }
    }
    activity = query.activity as Activity
  }

  const config = getProvider(providerId)
  const grain = config ? resolveSpecGrain(config) : 'provider'
  const connect = config
    ? resolveConnect(config)
    : { servers: [], securitySchemes: {}, security: [] }

  let pinnedModel: string | undefined
  if (query.model !== undefined) {
    const model = await getModelDetail(db, providerId, query.model)
    if (!model) {
      return {
        ok: false,
        status: 404,
        code: 'unknown_model',
        message: `Unknown model '${query.model}' for provider '${providerId}'. Try GET /v1/providers/${providerId}/models for valid ids.`,
      }
    }
    pinnedModel = model.rawId
    if (activity === undefined && model.activity) {
      activity = model.activity
    }
  }

  const loaded = await loadEndpoints(db, providerId, activity)
  let selected = loaded
  if (pinnedModel !== undefined) {
    const matching = loaded.filter((e) =>
      endpointMatchesModel(e.id, e.path, pinnedModel),
    )
    if (matching.length > 0) selected = matching
    else if (grain === 'model') {
      return {
        ok: false,
        status: 404,
        code: 'unknown_model',
        message: `No generation endpoint for model '${pinnedModel}' on provider '${providerId}'.`,
      }
    }
  }

  if (grain === 'model' && pinnedModel === undefined) {
    return refuseSelector(
      providerId,
      'model',
      loaded.length,
      `Provider '${providerId}' is model-grained.`,
    )
  }

  if (selected.length > MAX_SPEC_PATHS) {
    return refuseSelector(
      providerId,
      grain,
      selected.length,
      `Selection matches ${String(selected.length)} endpoints (cap ${String(MAX_SPEC_PATHS)}).`,
    )
  }

  const live = await listModelsCatalog(db, {
    provider: providerId,
    activity,
  })
  const modelIds = pinnedModel ? [pinnedModel] : live.models.map((m) => m.rawId)
  const paths: Record<string, Record<string, unknown>> = {}
  for (const endpoint of selected) {
    const item = paths[endpoint.path] ?? {}
    item.post = buildOperation(
      providerId,
      endpoint,
      connect,
      modelIds,
      pinnedModel,
    )
    if (connect.siblingGet) {
      const siblingPath = `${endpoint.path}/requests/{request_id}`
      paths[siblingPath] = { get: buildSiblingGet(providerId, endpoint) }
    }
    paths[endpoint.path] = item
  }

  const revision =
    selected.find((e) => e.specRevision)?.specRevision ?? 'current'
  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: {
      title: `${config?.displayName ?? providerId} (modelschemas)`,
      version: revision,
      description: `Generation-only OpenAPI assembled by modelschemas from live endpoint schemas. Call this provider directly with your own key — this is not a proxy.`,
    },
    servers: connect.servers,
    ...(Object.keys(connect.securitySchemes).length > 0
      ? {
          security: connect.security,
          components: { securitySchemes: connect.securitySchemes },
        }
      : {}),
    paths,
  }

  return {
    ok: true,
    document,
    etag: await contentHash(document),
  }
}
