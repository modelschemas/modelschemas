/**
 * Structural brand so zero-import generated request types match this package.
 * Provenance only — not liveness.
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

export type ListedModel<TProvider extends string = string> = {
  id: string
  provider: TProvider
  rawId: ListedModelId<TProvider>
}

/** Compile-time mint. Does not mean the id is still live. */
export function asListedModelId<TProvider extends string>(
  _provider: TProvider,
  rawId: string,
): ListedModelId<TProvider> {
  return rawId as ListedModelId<TProvider>
}

type Result<T> = { data?: T; error?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function brandModel<TProvider extends string>(
  provider: TProvider,
  value: unknown,
): ListedModel<TProvider> {
  const record = isRecord(value) ? value : {}
  const rawId = typeof record.rawId === 'string' ? record.rawId : ''
  const id = typeof record.id === 'string' ? record.id : rawId
  return { ...record, id, provider, rawId: asListedModelId(provider, rawId) }
}

function brandModelList<TProvider extends string>(
  data: unknown,
  fallbackProvider?: TProvider,
): { models: Array<ListedModel<TProvider>> } {
  const record = isRecord(data) ? data : {}
  const models: Array<ListedModel<TProvider>> = []
  for (const entry of Array.isArray(record.models) ? record.models : []) {
    if (!isRecord(entry)) continue
    const fromRow =
      typeof entry.provider === 'string' ? entry.provider : undefined
    const provider = (fallbackProvider ?? fromRow) as TProvider | undefined
    if (provider) models.push(brandModel(provider, entry))
  }
  return { ...record, models }
}

export async function listModels<const TProvider extends string = string>(
  options?: Options<ListModelsData> & { query?: { provider?: TProvider } },
): Promise<Result<{ models: Array<ListedModel<TProvider>> }>> {
  const result = await listModelsRaw(options)
  if (result.data === undefined) return result
  return {
    ...result,
    data: brandModelList(result.data, options?.query?.provider),
  }
}

export async function listProviderModels<const TProvider extends string>(
  options: Options<ListProviderModelsData> & { path: { provider: TProvider } },
): Promise<Result<{ models: Array<ListedModel<TProvider>> }>> {
  const result = await listProviderModelsRaw(options)
  if (result.data === undefined) return result
  return {
    ...result,
    data: brandModelList(result.data, options.path.provider),
  }
}

export async function getModel<const TProvider extends string>(
  options: Options<GetModelData> & {
    path: { provider: TProvider; modelId: string }
  },
): Promise<Result<ListedModel<TProvider>>> {
  const result = await getModelRaw(options)
  if (result.data === undefined) return result
  return { ...result, data: brandModel(options.path.provider, result.data) }
}
