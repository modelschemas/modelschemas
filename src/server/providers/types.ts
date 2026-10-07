import type { Activity } from '#/db/schema.ts'
import type { ChatRequestMap } from './request-map.ts'

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
   * Baseten Model APIs. `GET https://inference.baseten.co/v1/models` is
   * the catalog; it requires this key. Absent → listModels skips.
   */
  BASETEN_API_KEY?: string
  /**
   * Reactor (reactor.inc). Optional for sync/poll: `GET /pricing` is public
   * and the spec is embedded. The key (`rk_...`) is the data-plane
   * `Reactor-API-Key` header for `POST /tokens` and live sessions.
   */
  REACTOR_API_KEY?: string
  /**
   * PostHog project token (phc_…) for ingest failure events. Optional:
   * absent means capture is a no-op. US cloud, project 643425.
   */
  POSTHOG_PROJECT_KEY?: string
}

/**
 * How one catalog fact was arrived at (issue #53). Strongest first:
 * listing → docs-extracted → bound schema (`Derivation` rungs).
 * `generated` schemas are not walked onto catalog rows.
 */
export type FactDerivation = Derivation | 'listing' | 'docs-extracted'

/** Provenance for one stored catalog field or capability flag. */
export interface FactSource {
  derivation: FactDerivation
  sourceUrl?: string
  sourceHash?: string
  fetchedAt?: number
  /** Bound generation route, when the winner is the schema. */
  endpointId?: string
  /** JSON pointer or field name in the source document. */
  path?: string
}

/** Per-field (and per-flag) provenance for a catalog row. */
export interface ModelFactSources {
  /** `normalized`: the id matched only after dots were read as hyphens. */
  sameAs?: FactSource & { normalized?: true }
  contextWindow?: FactSource
  maxOutput?: FactSource
  modalities?: FactSource
  pricing?: FactSource
  capabilities?: Record<string, FactSource>
  reasoning?: FactSource
  /** Chat wire map read from this model's own request schema. */
  requestMap?: FactSource
  /** One source per tool type id in `serverTools`. */
  serverTools?: Record<string, FactSource>
}

/**
 * A provider's own statement of which upstream model a row is; kept even
 * while that model has no catalog row.
 */
export interface UpstreamModelIdentity {
  /** A provider id, or a name `provider_model_namespaces` maps to one. */
  providerNamespace: string
  rawId: string
  source: FactSource
}

/**
 * How a model's thinking is configured (issue #77). Null on a row means the
 * model does not reason, or its source names no control for it.
 *
 * `mode` names the one control the request exposes:
 * - `adaptive`: the model decides (Anthropic `thinking.type: adaptive`). A
 *   three-state switch with an `auto` value (`enabled | disabled | auto`)
 *   is `adaptive` too.
 * - `budget`: a token budget (`thinking.budget_tokens`, Gemini 2.5
 *   `thinkingBudget`). A switch plus a budget is `budget`.
 * - `effort`: a level (`reasoning_effort`, Gemini 3 `thinkingLevel`). A
 *   switch plus levels is `effort`.
 * - `toggle`: an on/off switch and nothing else (`thinking.type: enabled |
 *   disabled`, `enable_thinking`, `reasoning_mode: think | no_think`). It
 *   says nothing about whether the model thinks when the field is omitted.
 *
 * `mandatory` has one meaning on every mode:
 * - `true`: the provider's own source STATES thinking cannot be turned off
 *   for this model ("cannot be disabled", an upstream `mandatory` boolean).
 *   On a `toggle`: the model takes the switch and its off value is rejected,
 *   so send "on" or omit the field.
 * - `false`: the source states it can be turned off: documented prose, or
 *   an off value (`none`, `disabled`, `off`, `no_think`) in this model's
 *   OWN request schema or level list.
 * - `null`: unstated. Never read it as `false`: do not offer an off option
 *   from it, and do not claim thinking is forced. A schema SHARED by many
 *   models that lists an off value states nothing about one model, so it is
 *   `null`. A level list with no `none` is not a statement, so it is
 *   `null`. A probe (off returns 400) is not a source.
 *
 * `efforts`: the accepted effort values as published, an off value such as
 * `none` included. Never present on `toggle`.
 *
 * No object is stored when the source names no request field for the model:
 * a catalog flag alone, thinking picked by a model-id suffix or a prompt
 * tag, or a model that always thinks and takes no parameter. The
 * `reasoning` capability flag carries those. A `toggle` is stored only
 * with a stated `mandatory`: `{ mode: 'toggle', mandatory: null }` is not a
 * fact, and `reasoningViolation` refuses it.
 *
 * Many rows written before this rule infer `true` from a level list with
 * no `none`; README "Releasing on npm" lists the providers.
 */
export interface ModelReasoning {
  mode: 'adaptive' | 'budget' | 'effort' | 'toggle'
  mandatory: boolean | null
  efforts?: Array<string>
}

const REASONING_MODES = ['adaptive', 'budget', 'effort', 'toggle']

/**
 * Why a value is not a storable `ModelReasoning`, or null when it is. The
 * poller runs every listed row through this before the write.
 */
export function reasoningViolation(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'not an object'
  const { mode, mandatory, efforts } = value as Record<string, unknown>
  if (typeof mode !== 'string' || !REASONING_MODES.includes(mode)) {
    return `unknown mode ${JSON.stringify(mode)}`
  }
  if (mandatory !== null && typeof mandatory !== 'boolean') {
    return 'mandatory is not true, false or null'
  }
  if (mode === 'toggle' && mandatory === null) {
    return 'a toggle needs a stated mandatory'
  }
  if (efforts === undefined) return null
  if (mode === 'toggle') return 'a toggle takes no efforts'
  if (
    !Array.isArray(efforts) ||
    efforts.length === 0 ||
    !efforts.every((effort) => typeof effort === 'string' && effort !== '')
  ) {
    return 'efforts is not a non-empty array of strings'
  }
  return null
}

/** The stored model columns a listing fills; each can be marked absent. */
export type ModelFact =
  | 'displayName'
  | 'activity'
  | 'contextWindow'
  | 'maxOutput'
  | 'modalities'
  | 'pricing'
  | 'capabilities'
  | 'reasoning'
  | 'serverTools'
  | 'requestMap'
  | 'aliases'
  | 'schemaEndpointId'

/**
 * Why a listing carries no value for a fact, when the adapter knows why.
 * The poller's whole contract for one fact (the table describes the code;
 * the fills on a bare omission predate it and every provider relies on them):
 *
 * | listing            | poller writes                          | signal          |
 * | ------------------ | -------------------------------------- | --------------- |
 * | a value            | the value                              | none            |
 * | nothing, no reason | pricing: the stored card.              | pricing only:   |
 * |                    | capabilities, modalities: what the     | `pricing_lost`  |
 * |                    | bound request schema states, else null.| and 1 failure   |
 * |                    | requestMap: the provider table's map,  |                 |
 * |                    | else null. Any other fact: null        |                 |
 * | `cleared`          | null, and the schema does not refill   | none            |
 * |                    | it. requestMap: still the provider     |                 |
 * |                    | table's map (no stored "no map")       |                 |
 * | `unavailable`      | the stored value and source            | the docs failure|
 *
 * - `cleared`: the source was read and has no value now (router hosts that
 *   stopped agreeing, a price moved to a subscription). Only say it for a
 *   value the source visibly lacks; a shape the parser cannot read must
 *   throw. The poller refuses a poll that clears most of a provider's
 *   prices at once (`refusesPriceClears`).
 * - `unavailable`: the source could not be read this poll (`tryDocs`). A
 *   new row has nothing stored, so the fact is null.
 * - A reason wins over a value the listing also carries.
 *
 * Only pricing keeps its stored value on a bare omission: a parser that
 * misses one row must not null a good price. `factSources.<fact>.path:
 * 'silent'` is not this. It is stored provenance for a null whose page was
 * read, and the fact is written like any omission. `deprecated` is not a
 * fact here: a stored `deprecatedAt` cannot tell "upstream flagged it"
 * from "it dropped off the listing".
 */
export type FactAbsence = 'cleared' | 'unavailable'

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
  /**
   * True when `capabilities` is the model's whole flag list, read from its
   * own branch of a request body other models share. The bound request
   * schema then adds no flags: walked whole, it would give each model its
   * siblings' fields.
   */
  exactCapabilities?: boolean
  /** Thinking configuration; null when the model does not reason or docs are silent. */
  reasoning?: ModelReasoning | null
  /**
   * Provider-hosted tool type ids the model accepts in `tools`
   * (`web_search_20250305`, `google_search`, …). Null when unknown.
   */
  serverTools?: Array<string> | null
  /**
   * Chat request wire map (issue #95). The poller fills this from
   * `chatRequestMap`; listings do not invent it. Null when unverified.
   * A listing sets it only from the model's own published request schema
   * (Workers AI); the poller then keeps that map.
   */
  requestMap?: ChatRequestMap | null
  /**
   * Per-field provenance for the facts this listing already filled.
   * The poller defaults untagged listing fields to `derivation: listing`.
   */
  factSources?: ModelFactSources
  /** Facts with no value this poll for a known reason; wins over a value. */
  absent?: Partial<Record<ModelFact, FactAbsence>>
  /**
   * Generation route (public endpoint id) when it depends on listing data
   * the read path cannot see — Gemini's `supportedGenerationMethods`.
   * Omit to let the provider's `generationEndpointId` bind by activity.
   */
  schemaEndpointId?: string | null
  /**
   * Caller ids that resolve to this row (Anthropic `claude-opus-4-5` →
   * the dated snapshot). Empty when the provider documents none.
   */
  aliases?: Array<string> | null
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
   * stable-stringified JSON for documents embedded in API responses (FAL),
   * decompressed JSON for Stainless-bundled gzip specs (Anthropic, Groq).
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
  /** Upstream revision identifier when one exists (e.g. the SHA-256 of a Stainless-bundled spec). */
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

/** One docs source `listModels` could not read this poll. */
export interface DocsFailure {
  /** The document's URL. */
  source: string
  error: string
  /** How long the failed load took; a timeout shows as one. */
  elapsedMs: number
}

/** What one poll's docs loads came to (`docsReport`). */
export interface DocsFailures {
  /** Documents whose load or parse threw. */
  failed: number
  /** Documents not attempted once the failure budget was spent. */
  skipped: number
  /** The first few failures; `failed` is the whole count. */
  first: Array<DocsFailure>
}

export interface ListModelsResult {
  models: Array<ModelInfo>
  /**
   * Docs sources that failed while the listing itself loaded (`tryDocs`).
   * The poll goes on; rows mark the facts those sources supply
   * `unavailable`. A failed listing still throws. An adapter that uses
   * `tryDocs` always returns this, zeros included: that is what clears
   * the provider's `docs-failing` record.
   */
  docsFailures?: DocsFailures
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
   * Names other providers' model ids use for this provider (`google/…` →
   * gemini). Stored in `provider_model_namespaces`; used only for sameAs.
   */
  modelNamespaces?: Array<string>
  /**
   * Upstream identity read from a raw id, using an id format this provider
   * itself publishes; null when the id does not follow it. Never guess.
   */
  upstreamModelIdentity?: (rawId: string) => UpstreamModelIdentity | null
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
  listModels: (
    env: ProviderSecrets,
    kv?: KVNamespace,
  ) => Promise<ListModelsResult>
  /**
   * Classify an endpoint to an activity group; `null` means platform/admin
   * surface — dropped from schema generation.
   */
  classify: (path: string, op: OpenApiOperation) => Activity | null
  /**
   * Also classify GET operations. Off by default: many specs publish
   * GETs on generation paths that are not the generation call. BytePlus
   * video needs GET /contents/generations/tasks/{id}, which is where the
   * video URL comes back.
   */
  classifyGets?: boolean
  /**
   * Drop a listed `schemaEndpointId` until its route has a synced input
   * schema. For listings that name per-model routes the daily sync creates
   * later (Replicate): a link to an unsynced route would 404.
   */
  bindSyncedRoutesOnly?: boolean
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
  /**
   * Capability flags the shared request schema carries but the provider
   * says not every model supports (Perplexity: reasoning, tools). The
   * schema walk leaves them off; a listing that states one still sets it.
   */
  perModelSchemaFlags?: Array<string>
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
 * Parse a gzipped OpenAPI JSON document bundled in a Stainless SDK repo
 * (the mock-server spec — the real spec, now that `.stats.yml` no longer
 * carries `openapi_spec_url`). Throws on non-gzip bytes, bad JSON, or a
 * document without `openapi` + `paths`, so the provider stays degraded
 * rather than serving a stale fallback. The decompressed JSON's hash is
 * the specRevision.
 */
export async function parseGzippedOpenApi(
  bytes: Uint8Array<ArrayBuffer>,
  providerId: string,
  url: string,
): Promise<SpecFetchResult> {
  let text: string
  let spec: OpenApiDocument | null
  try {
    text = await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text()
    spec = JSON.parse(text) as OpenApiDocument | null
  } catch (err) {
    throw new Error(
      `${providerId}: bundled spec at ${url} is not gzipped JSON (${String(err)})`,
    )
  }
  if (typeof spec?.openapi !== 'string' || !spec.paths) {
    throw new Error(`${providerId}: bundled spec at ${url} is not OpenAPI`)
  }
  const hash = await sha256Text(text)
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
    specRevision: hash,
  }
}

/** Standard skip result for providers whose secret is absent. */
export function skippedResult(
  providerId: string,
  envVar: string,
): { skipped: string } {
  return { skipped: `${providerId}: ${envVar} not set — skipped` }
}
