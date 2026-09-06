import type { Activity } from '#/db/schema.ts'

/**
 * Provider registry types — ported from TanStack AI PR #622's
 * `ProviderConfig`, adapted to Workers: no filesystem caching (fetchSpec
 * returns parsed documents), and model listing is a first-class operation
 * (the 15-minute poll tier).
 */

/**
 * How a schema's content was arrived at — a trust ladder, strongest first.
 * Agents use it to weigh how much a schema can be relied on, and it makes a
 * stale hand-written corner visible instead of invisible.
 *
 * - `upstream-spec`  — extracted from a machine-readable document the
 *   provider itself publishes and we re-fetch every sync. Self-healing.
 * - `generated`      — derived at sync time from a provider-published
 *   artifact that is not a spec (BytePlus's Go SDK structs). Also
 *   self-healing, one inference step removed from the wire.
 * - `probe-verified` — hand-written, but every field confirmed against live
 *   API calls on `verifiedAt`. Accurate as of that date; does not self-heal.
 * - `docs-derived`   — hand-written from prose documentation and NOT
 *   confirmed against the API. The weakest claim we make.
 */
export type Derivation =
  | 'upstream-spec'
  | 'generated'
  | 'probe-verified'
  | 'docs-derived'

/**
 * Operation-level provenance annotation, read back by the sync engine —
 * same trick as FAL's activity marker. Set it on an OpenAPI operation to
 * override the provider's `defaultDerivation` for that one endpoint.
 */
export const PROVENANCE_MARKER = 'x-modelschemas-provenance'

export interface EndpointProvenance {
  derivation: Derivation
  /**
   * `YYYY-MM-DD` the claim was last confirmed. Meaningful for
   * `probe-verified`; omitted for the self-healing derivations, whose
   * freshness is already the sync timestamp.
   */
  verifiedAt?: string
}

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
  /**
   * BytePlus Ark data plane. Optional: it upgrades BytePlus's model catalog
   * from the embedded one to Ark's live listing. Region-isolated — a key
   * issued for ap-southeast does not work against the EU host.
   */
  ARK_API_KEY?: string
  /**
   * BytePlus Seed Speech (the voice host) — a separate product key from Ark;
   * an Ark key there fails with `45000010 Invalid X-Api-Key`. Not consumed by
   * the sync pipeline (Seed Speech exposes no spec or model-list endpoint);
   * declared so local probe scripts share one canonical name.
   */
  SEED_SPEECH_API_KEY?: string
  // Adapter-batch secrets (docs/providers-to-add.md). Optional: a missing
  // key skips listModels; fetchSpec stays keyless whenever the spec is public.
  MISTRAL_API_KEY?: string
  REPLICATE_API_TOKEN?: string
  GROQ_API_KEY?: string
  FIREWORKS_API_KEY?: string
  TOGETHER_API_KEY?: string
  VOYAGE_API_KEY?: string
  COHERE_API_KEY?: string
  DEEPSEEK_API_KEY?: string
  MOONSHOT_API_KEY?: string
  DASHSCOPE_API_KEY?: string
  DEEPGRAM_API_KEY?: string
  ASSEMBLYAI_API_KEY?: string
  RUNWAY_API_KEY?: string
  CARTESIA_API_KEY?: string
  PERPLEXITY_API_KEY?: string
  CEREBRAS_API_KEY?: string
  SAMBANOVA_API_KEY?: string
  JINA_API_KEY?: string
  STABILITY_API_KEY?: string
  BFL_API_KEY?: string
  KLING_API_KEY?: string
  HYPERBOLIC_API_KEY?: string
  NOVITA_API_KEY?: string
  /**
   * Reactor (reactor.inc). Optional for sync/poll: `GET /pricing` is public
   * and the spec is embedded. The key (`rk_...`) is the data-plane
   * `Reactor-API-Key` header for `POST /tokens` and live sessions.
   */
  REACTOR_API_KEY?: string
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
  /**
   * Upstream release/creation time (epoch seconds) when the provider reports
   * one; used to backdate `models.firstSeenAt` (issue #1). Null/absent when
   * the provider has no date for the model.
   */
  releasedAt?: number | null
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

/**
 * Already-extracted generation endpoint that is not an OpenAPI path
 * (FAL WMA AsyncAPI). Merged into classifyAndBundle; not assembled into
 * GET /v1/openapi/{provider}.
 */
export interface BundledEndpoint {
  path: string
  activity: Activity
  description: string | null
  source: SpecSource
  derivation: Derivation
  verifiedAt?: string | null
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  /** Catalog `capabilities.asyncapi` and skip HTTP OpenAPI assembly. */
  asyncapi?: boolean
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
  /**
   * Non-fatal problems encountered while fetching/derivating the documents —
   * e.g. BytePlus falling back to its embedded Ark document when the Go SDK
   * it generates from is unreachable. Surfaced on the sync outcome.
   */
  warnings?: Array<string>
  /** Set when the provider was skipped (e.g. missing secret); specs will be empty. */
  skipped?: string
  /**
   * Extra bundled endpoints (AsyncAPI) appended after OpenAPI classify.
   */
  bundledEndpoints?: Array<BundledEndpoint>
  /**
   * Listed model rawIds whose generation surface is AsyncAPI. Present
   * (including `[]`) when the fetch evaluated that; omitted when skipped.
   * Sync writes `capabilities.asyncapi` on matching catalog rows.
   */
  asyncApiRawIds?: Array<string>
}

export interface ListModelsResult {
  models: Array<ModelInfo>
  /** Set when the provider was skipped (e.g. missing secret); models will be empty. */
  skipped?: string
}

/**
 * How a provider's generation surface is addressed. `provider` — a handful
 * of shared endpoints, model is a request field. `model` — one API per
 * model (FAL); a combined OpenAPI document is not served.
 */
export type SpecGrain = 'provider' | 'model'

/** OpenAPI 3 security scheme subset we emit on assembled provider specs. */
export type OpenApiSecurityScheme =
  | {
      type: 'http'
      scheme: string
      bearerFormat?: string
      description?: string
    }
  | {
      type: 'apiKey'
      in: 'header' | 'query' | 'cookie'
      name: string
      description?: string
    }

/**
 * How to call this provider's data plane. Declared, not guessed from the
 * upstream spec (those are often incomplete). Used to assemble
 * `GET /v1/openapi/{provider}`.
 */
export interface ProviderConnect {
  servers: Array<{ url: string; description?: string }>
  securitySchemes: Record<string, OpenApiSecurityScheme>
  security: Array<Record<string, Array<string>>>
  /** Header name → const value (e.g. `anthropic-version`). */
  requiredHeaders?: Record<string, string>
  /**
   * Include sibling `GET {path}/requests/{request_id}` carrying the output
   * schema (FAL queue). The POST keeps the input schema only.
   */
  siblingGet?: boolean
}

export interface ProviderConfig {
  /** Lowercase slug; matches `providers.id` and the seed data. */
  id: string
  displayName: string
  /** Env var holding the API key; undefined for keyless providers. */
  authEnvVar?: keyof ProviderSecrets
  /**
   * Seed metadata. Required on auto-registered adapters under
   * `./adapters/`; optional on the original 8, which keep their rows in
   * `seed-providers.ts`.
   */
  specSourceUrl?: string
  modelsEndpoint?: string
  /**
   * Derivation recorded for this provider's endpoints unless an operation
   * carries its own {@link PROVENANCE_MARKER}. Providers that re-fetch a
   * published spec every sync declare `upstream-spec`.
   */
  defaultDerivation: Derivation
  /**
   * How this provider's generation surface is addressed. Defaults to
   * `provider` when omitted (adapters).
   */
  specGrain?: SpecGrain
  /** How to call the provider; assembled into GET /v1/openapi/{id}. */
  connect?: ProviderConnect
  /**
   * Per-activity override when one provider has multiple data planes
   * (BytePlus Ark vs Seed Speech). Mixed selections drop overridden
   * activities from the default document.
   */
  connectByActivity?: Partial<Record<Activity, ProviderConnect>>
  /** Fetch + parse the provider's OpenAPI spec document(s). */
  fetchSpec: (env: ProviderSecrets) => Promise<SpecFetchResult>
  /** List currently served models from the provider's cheap models endpoint. */
  listModels: (env: ProviderSecrets) => Promise<ListModelsResult>
  /**
   * Classify an endpoint to an activity group; `null` means platform/admin
   * surface — dropped from schema generation.
   */
  classify: (path: string, op: OpenApiOperation) => Activity | null
  /**
   * Canonical generation route (public endpoint id) for a listed model.
   * Grain=provider catalogs use this so a client can go model id → input
   * schema without hardcoding `v1/images/generations`. Omitted providers
   * have no model→route binding unless they are model-grained (the raw
   * id *is* the endpoint id).
   */
  generationEndpointId?: (model: {
    rawId: string
    activity: Activity
    capabilities?: unknown
  }) => string | null
}

/** Fetch a JSON or YAML OpenAPI document and hash the raw bytes. */
export async function fetchOpenApi(url: string): Promise<{
  spec: OpenApiDocument
  text: string
  hash: string
}> {
  const { parse } = await import('yaml')
  const text = await fetchText(url)
  const hash = await sha256Text(text)
  const trimmed = text.trimStart()
  const spec = (
    trimmed.startsWith('{') || trimmed.startsWith('[')
      ? JSON.parse(text)
      : parse(text)
  ) as OpenApiDocument
  return { spec, text, hash }
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

/**
 * Read `openapi_spec_url` out of a Stainless SDK `.stats.yml`. The file is
 * plain key-value YAML; we only need one field, so skip a full parse.
 */
export function stainlessSpecUrlFromStats(
  text: string,
  providerId: string,
): string {
  const url = text.match(/^openapi_spec_url:\s*(.+)$/m)?.[1]?.trim()
  if (!url) {
    throw new Error(`${providerId} .stats.yml: couldn't find openapi_spec_url`)
  }
  return url
}

/**
 * Resolve the current spec URL from a Stainless SDK repo's `.stats.yml`
 * (a hash-stamped YAML in GCS that updates whenever the provider ships a
 * new API revision). The resolved URL doubles as the specRevision.
 */
export async function resolveStainlessSpecUrl(
  providerId: string,
  statsUrl: string,
): Promise<string> {
  return stainlessSpecUrlFromStats(await fetchText(statsUrl), providerId)
}

/** Standard skip result for providers whose secret is absent. */
export function skippedResult(
  providerId: string,
  envVar: string,
): { skipped: string } {
  return { skipped: `${providerId}: ${envVar} not set — skipped` }
}
