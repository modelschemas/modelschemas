/**
 * @modelschemas/client — typed fetch client for the modelschemas service.
 *
 * Everything under ./generated is produced by @hey-api/openapi-ts from the
 * service's own openapi.json (bun run generate:client); this file is the
 * hand-written entry adding pluggable auth and branded model ids.
 */
import { createClient, createConfig } from './generated/client'

import type { ClientOptions } from './generated/types.gen'

export {
  getActivitySchemas,
  getProviderOpenApi,
  getSchema,
  getServiceIndex,
  getStatus,
  listAllSchemas,
  listChanges,
  listProviders,
  listProviderSchemas,
  type Options,
  syncProvider,
  validatePayload,
} from './generated/index'
export type {
  ClientOptions,
  Error,
  GetActivitySchemasData,
  GetActivitySchemasError,
  GetActivitySchemasErrors,
  GetActivitySchemasResponse,
  GetActivitySchemasResponses,
  GetModelData,
  GetModelError,
  GetModelErrors,
  GetModelResponse,
  GetModelResponses,
  GetProviderOpenApiData,
  GetProviderOpenApiError,
  GetProviderOpenApiErrors,
  GetProviderOpenApiResponse,
  GetProviderOpenApiResponses,
  GetSchemaData,
  GetSchemaError,
  GetSchemaErrors,
  GetSchemaResponse,
  GetSchemaResponses,
  GetServiceIndexData,
  GetServiceIndexResponse,
  GetServiceIndexResponses,
  GetStatusData,
  GetStatusResponse,
  GetStatusResponses,
  ListAllSchemasData,
  ListAllSchemasResponse,
  ListAllSchemasResponses,
  ListChangesData,
  ListChangesResponse,
  ListChangesResponses,
  ListModelsData,
  ListModelsResponse,
  ListModelsResponses,
  ListProviderModelsData,
  ListProviderModelsError,
  ListProviderModelsErrors,
  ListProviderModelsResponse,
  ListProviderModelsResponses,
  ListProviderSchemasData,
  ListProviderSchemasError,
  ListProviderSchemasErrors,
  ListProviderSchemasResponse,
  ListProviderSchemasResponses,
  ListProvidersData,
  ListProvidersResponse,
  ListProvidersResponses,
  ServiceStatus,
  SyncProviderData,
  SyncProviderError,
  SyncProviderErrors,
  SyncProviderResponse,
  SyncProviderResponses,
  ValidatePayloadData,
  ValidatePayloadError,
  ValidatePayloadErrors,
  ValidatePayloadResponse,
  ValidatePayloadResponses,
  ValidateRequest,
  ValidateResult,
} from './generated/index'
export { createClient, createConfig }
export {
  asListedModelId,
  getModel,
  listModels,
  listProviderModels,
  type ListedModel,
  type ListedModelId,
} from './listed-model.ts'

export interface ModelschemasClientOptions {
  /** Service origin, e.g. https://modelschemas.example.com */
  baseUrl: string
  /** API key (POST /v1/agents/register-key) sent as Authorization: Bearer. */
  apiKey?: string
  /** Pre-signed agent JWT (agent-auth protocol) — alternative to apiKey. */
  agentJwt?: string
  fetch?: typeof globalThis.fetch
}

/**
 * Create a configured client instance to pass to any SDK call via the
 * `client` option:
 *
 * ```ts
 * const client = createModelschemasClient({ baseUrl, apiKey })
 * const { data } = await listProviders({ client })
 * ```
 */
export function createModelschemasClient(options: ModelschemasClientOptions) {
  const credential = options.apiKey ?? options.agentJwt
  return createClient(
    createConfig<ClientOptions>({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      headers: credential
        ? { Authorization: `Bearer ${credential}` }
        : undefined,
    }),
  )
}
