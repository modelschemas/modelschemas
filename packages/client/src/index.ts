/**
 * @modelschemas/client — typed fetch client for the modelschemas service.
 *
 * Everything under ./generated is produced by @hey-api/openapi-ts from the
 * service's own openapi.json (bun run generate:client); this file is the
 * hand-written entry adding pluggable auth and branded model ids.
 */
import { createClient, createConfig } from './generated/client/index.js'

import type { ClientOptions } from './generated/types.gen.js'

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
  estimateCost,
  exportCatalog,
  extractFalPricing,
  syncProvider,
  validatePayload,
} from './generated/index.js'
// Everything the generator emits except the RateCard types: the spec types a
// card's `price` and `tables` as unknown, so those do not fit `evaluateCard`.
// Import `RateCard` from `@modelschemas/rate-card`; rows from the model calls
// below already carry it. A new schema in the spec needs adding to this list.
export type {
  ClientOptions,
  Error,
  ServiceStatus,
  Change,
  ChangesPage,
  ExportSchemaVersion,
  ValidateRequest,
  ValidateResult,
  CompactPricing,
  PricingRange,
  PriceBounds,
  ChatRequestMap,
  HalLink,
  ModelLinks,
  FactSource,
  FactSourceMap,
  ModelFactSources,
  FactDiscrepancy,
  Model,
  ExportModel,
  ModelDetail,
  ModelList,
  ProviderModelList,
  EstimateRequest,
  EstimateResult,
  EstimateRouteResult,
  EstimateByInputResult,
  EstimateRangeResult,
  GetServiceIndexData,
  GetServiceIndexResponses,
  GetServiceIndexResponse,
  GetStatusData,
  GetStatusResponses,
  GetStatusResponse,
  ListProvidersData,
  ListProvidersResponses,
  ListProvidersResponse,
  ListProviderModelsData,
  ListProviderModelsErrors,
  ListProviderModelsError,
  ListProviderModelsResponses,
  ListProviderModelsResponse,
  ListModelsData,
  ListModelsResponses,
  ListModelsResponse,
  GetModelData,
  GetModelErrors,
  GetModelError,
  GetModelResponses,
  GetModelResponse,
  ListAllSchemasData,
  ListAllSchemasResponses,
  ListAllSchemasResponse,
  ListProviderSchemasData,
  ListProviderSchemasErrors,
  ListProviderSchemasError,
  ListProviderSchemasResponses,
  ListProviderSchemasResponse,
  GetActivitySchemasData,
  GetActivitySchemasErrors,
  GetActivitySchemasError,
  GetActivitySchemasResponses,
  GetActivitySchemasResponse,
  GetSchemaData,
  GetSchemaErrors,
  GetSchemaError,
  GetSchemaResponses,
  GetSchemaResponse,
  GetProviderOpenApiData,
  GetProviderOpenApiErrors,
  GetProviderOpenApiError,
  GetProviderOpenApiResponses,
  GetProviderOpenApiResponse,
  ValidatePayloadData,
  ValidatePayloadErrors,
  ValidatePayloadError,
  ValidatePayloadResponses,
  ValidatePayloadResponse,
  EstimateCostData,
  EstimateCostErrors,
  EstimateCostError,
  EstimateCostResponses,
  EstimateCostResponse,
  ListChangesData,
  ListChangesResponses,
  ListChangesResponse,
  SyncProviderData,
  SyncProviderErrors,
  SyncProviderError,
  SyncProviderResponses,
  SyncProviderResponse,
  ExtractFalPricingData,
  ExtractFalPricingErrors,
  ExtractFalPricingError,
  ExtractFalPricingResponses,
  ExtractFalPricingResponse,
  ExportCatalogData,
  ExportCatalogErrors,
  ExportCatalogError,
  ExportCatalogResponses,
  ExportCatalogResponse,
} from './generated/types.gen.js'
export { createClient, createConfig }
export {
  asListedModelId,
  getModel,
  listModels,
  listProviderModels,
  type ListedModel,
  type ListedModelList,
  type ListedModelId,
} from './listed-model.js'

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
