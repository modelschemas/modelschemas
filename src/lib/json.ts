import type { ApiModel } from '#/server/catalog.ts'

/** Plain JSON — what server functions may return to loaders. */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json }
  | Array<Json>

/**
 * ApiModel with its `unknown` JSON columns (drizzle json mode) narrowed so
 * TanStack's server-fn serializability check accepts it. The values really
 * are plain JSON — they come out of D1 text columns.
 */
export type SerializableModel = Omit<
  ApiModel,
  'modalities' | 'pricing' | 'capabilities' | '_links'
> & {
  modalities: Json
  pricing: Json
  capabilities: Json
  _links: Json
}
