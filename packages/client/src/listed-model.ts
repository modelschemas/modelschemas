/**
 * Provenance brand for model ids that flowed through our catalog reads.
 * Structural (string key, not unique symbol) so zero-import generated
 * request types agree with this package.
 */
import {
  getModel as getModelRaw,
  listModels as listModelsRaw,
  listProviderModels as listProviderModelsRaw,
} from './generated/sdk.gen'
import type { Options } from './generated/sdk.gen'
import type {
  GetModelData,
  ListModelsData,
  ListProviderModelsData,
} from './generated/types.gen'

export type ListedModelId<TProvider extends string = string> = string & {
  readonly __modelschemasListed: TProvider
}

/** Compile-time mint. Does not mean the id is still live. */
export function asListedModelId<TProvider extends string>(
  _provider: TProvider,
  rawId: string,
): ListedModelId<TProvider> {
  return rawId as ListedModelId<TProvider>
}

export interface ListedModel<TProvider extends string = string> {
  id: string
  provider: TProvider
  rawId: ListedModelId<TProvider>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function brandModel(provider: string, value: unknown): unknown {
  if (!isRecord(value) || typeof value.rawId !== 'string') return value
  return {
    ...value,
    rawId: asListedModelId(provider, value.rawId),
  }
}

function brandCatalog(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data.models)) return data
  return {
    ...data,
    models: data.models.map((entry: unknown) => {
      if (!isRecord(entry)) return entry
      const provider =
        typeof entry.provider === 'string' ? entry.provider : undefined
      return provider ? brandModel(provider, entry) : entry
    }),
  }
}

function brandProviderList(provider: string, data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data.models)) return data
  return {
    ...data,
    models: data.models.map((model) => brandModel(provider, model)),
  }
}

/** Cross-provider catalog; brands `rawId` with each row's provider. */
export async function listModels<TThrowOnError extends boolean = false>(
  options?: Options<ListModelsData, TThrowOnError>,
) {
  const result = await listModelsRaw(options)
  if (result.data !== undefined) {
    ;(result as { data: unknown }).data = brandCatalog(result.data)
  }
  return result
}

/** One provider's models; brands `rawId` with that provider. */
export async function listProviderModels<TThrowOnError extends boolean = false>(
  options: Options<ListProviderModelsData, TThrowOnError>,
) {
  const result = await listProviderModelsRaw(options)
  if (result.data !== undefined) {
    ;(result as { data: unknown }).data = brandProviderList(
      options.path.provider,
      result.data,
    )
  }
  return result
}

/** One model; brands `rawId` with the path provider. */
export async function getModel<TThrowOnError extends boolean = false>(
  options: Options<GetModelData, TThrowOnError>,
) {
  const result = await getModelRaw(options)
  if (result.data !== undefined) {
    ;(result as { data: unknown }).data = brandModel(
      options.path.provider,
      result.data,
    )
  }
  return result
}
