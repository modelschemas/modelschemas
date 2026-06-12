import type { Activity } from '#/db/schema.ts'

/**
 * Provider registry types — ported from TanStack AI PR #622's
 * `ProviderConfig`, adapted to Workers: no filesystem caching (fetchSpec
 * returns parsed documents), and model listing is a first-class operation
 * (the 15-minute poll tier).
 */

/** A parsed OpenAPI document (loosely typed; pure JSON manipulation). */
export type OpenApiOperation = Record<string, unknown>

export interface OpenApiDocument {
  openapi?: string
  info?: Record<string, unknown>
  servers?: Array<Record<string, unknown>>
  paths?: Record<string, Record<string, OpenApiOperation>>
  components?: { schemas?: Record<string, unknown> } & Record<string, unknown>
  [key: string]: unknown
}

/** Secrets a provider may need; mirrors `providers.auth_env_var` values. */
export interface ProviderSecrets {
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  GEMINI_API_KEY?: string
  XAI_API_KEY?: string
  ELEVENLABS_API_KEY?: string
  FAL_KEY?: string
}

/** Normalised model entry (maps onto the `models` table shape). */
export interface ModelInfo {
  rawId: string
  displayName?: string | null
  activity?: Activity | null
  contextWindow?: number | null
  maxOutput?: number | null
  modalities?: unknown
  pricing?: unknown
  capabilities?: unknown
  deprecated?: boolean
}

/** Provenance for one fetched spec document. */
export interface SpecSource {
  /** URL the document was fetched from. */
  url: string
  /**
   * SHA-256 hex of the document as fetched — raw bytes when the upstream
   * serves a file (reproducible with `curl <url> | shasum -a 256`),
   * stable-stringified JSON for documents embedded in API responses (FAL).
   */
  hash: string
}

export interface SpecFetchResult {
  specs: Array<OpenApiDocument>
  /** Per-document provenance, index-aligned with `specs`. */
  sources: Array<SpecSource>
  /**
   * Output-schema derivation strategy (PR #622):
   * - 'post-200': POST .responses["200"].content (most providers)
   * - 'sibling-get': sibling GET `${path}/requests/{request_id}` (FAL —
   *   the POST returns a queue ack)
   */
  outputStrategy: 'post-200' | 'sibling-get'
  /** Upstream revision identifier when one exists (e.g. Anthropic's hash-stamped spec URL). */
  specRevision?: string
  /** Set when the provider was skipped (e.g. missing secret); specs will be empty. */
  skipped?: string
}

export interface ListModelsResult {
  models: Array<ModelInfo>
  /** Set when the provider was skipped (e.g. missing secret); models will be empty. */
  skipped?: string
}

export interface ProviderConfig {
  /** Lowercase slug; matches `providers.id` and the seed data. */
  id: string
  displayName: string
  /** Env var holding the API key; undefined for keyless providers. */
  authEnvVar?: keyof ProviderSecrets
  /** Fetch + parse the provider's OpenAPI spec document(s). */
  fetchSpec: (env: ProviderSecrets) => Promise<SpecFetchResult>
  /** List currently served models from the provider's cheap models endpoint. */
  listModels: (env: ProviderSecrets) => Promise<ListModelsResult>
  /**
   * Classify an endpoint to an activity group; `null` means platform/admin
   * surface — dropped from schema generation.
   */
  classify: (path: string, op: OpenApiOperation) => Activity | null
}

export async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(
      `fetch failed: ${url} → ${String(response.status)} ${response.statusText}`,
    )
  }
  return response.json()
}

/** SHA-256 hex of raw fetched text (the `SpecSource.hash` for file specs). */
export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function fetchText(
  url: string,
  init?: RequestInit,
): Promise<string> {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(
      `fetch failed: ${url} → ${String(response.status)} ${response.statusText}`,
    )
  }
  return response.text()
}

/** Standard skip result for providers whose secret is absent. */
export function skippedResult(
  providerId: string,
  envVar: string,
): { skipped: string } {
  return { skipped: `${providerId}: ${envVar} not set — skipped` }
}
