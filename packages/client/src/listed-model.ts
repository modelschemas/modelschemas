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
  Model,
  ModelDetail,
  ModelList,
  ProviderModelList,
} from './generated/types.gen'

export type ListedModelId<TProvider extends string = string> = string & {
  readonly __modelschemasListed: TProvider
}

/** A served model row whose rawId is branded with its provider. */
export type ListedModel<
  TProvider extends string = string,
  TRow extends Model = Model,
> = Omit<TRow, 'provider' | 'rawId'> & {
  provider: TProvider
  rawId: ListedModelId<TProvider>
}

/** A model list response whose rows carry branded rawIds. */
export type ListedModelList<
  TProvider extends string,
  TList extends { models: Array<Model> },
> = Omit<TList, 'models'> & { models: Array<ListedModel<TProvider>> }

/** Compile-time mint. Does not mean the id is still live. */
export function asListedModelId<TProvider extends string>(
  _provider: TProvider,
  rawId: string,
): ListedModelId<TProvider> {
  return rawId as ListedModelId<TProvider>
}

type Result<T> = { data?: T; error?: unknown }

function brandModel<TProvider extends string, TRow extends Model>(
  provider: TProvider,
  row: TRow,
): ListedModel<TProvider, TRow> {
  return { ...row, provider, rawId: asListedModelId(provider, row.rawId) }
}

function brandModelList<
  TProvider extends string,
  TList extends { models: Array<Model> },
>(data: TList, provider?: TProvider): ListedModelList<TProvider, TList> {
  return {
    ...data,
    models: data.models.map((row) =>
      brandModel((provider ?? row.provider) as TProvider, row),
    ),
  }
}

export async function listModels<const TProvider extends string = string>(
  options?: Options<ListModelsData> & { query?: { provider?: TProvider } },
): Promise<Result<ListedModelList<TProvider, ModelList>>> {
  const result = await listModelsRaw(options)
  if (result.data === undefined) return result
  return {
    ...result,
    data: brandModelList(result.data, options?.query?.provider),
  }
}

export async function listProviderModels<const TProvider extends string>(
  options: Options<ListProviderModelsData> & { path: { provider: TProvider } },
): Promise<Result<ListedModelList<TProvider, ProviderModelList>>> {
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
): Promise<Result<ListedModel<TProvider, ModelDetail>>> {
  const result = await getModelRaw(options)
  if (result.data === undefined) return result
  return { ...result, data: brandModel(options.path.provider, result.data) }
}
