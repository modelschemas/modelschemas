/**
 * FAL — one OpenAPI spec per model from the FAL models API
 * (`expand=openapi-3.0`; NB the param is plain `expand`, not `expand[]` —
 * the bracketed form is silently ignored). Requires FAL_KEY; skipped with a
 * recorded warning when absent. Output schemas use the `sibling-get`
 * strategy (the POST returns a queue ack).
 *
 * Activity comes from the model's `<source>-to-<target>` category, not the
 * path, so fetchSpec annotates every operation with FAL_ACTIVITY_MARKER and
 * classify reads it back.
 */
import type { Activity } from '#/db/schema.ts'
import { activities } from '#/db/schema.ts'
import { skippedResult } from './types.ts'
import type {
  ListModelsResult,
  ModelInfo,
  OpenApiDocument,
  OpenApiOperation,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from './types.ts'

const FAL_MODELS_URL = 'https://api.fal.ai/v1/models'

export const FAL_ACTIVITY_MARKER = 'x-modelschemas-fal-activity'

interface FalApiModel {
  endpoint_id: string
  openapi?: OpenApiDocument
  metadata: {
    display_name?: string
    category: string
    description?: string
    status?: 'active' | 'inactive' | 'deprecated'
    [key: string]: unknown
  }
}

interface FalApiResponse {
  models: Array<FalApiModel>
  has_more: boolean
  next_cursor: string | null
}

/**
 * Full-category overrides, applied before the target-modality mapping.
 * Transcription belongs in `audio` regardless of its `text` target;
 * `training` is fine-tuning (platform — dropped), `workflow`/`unknown` are
 * not generation endpoints.
 */
const FAL_CATEGORY_OVERRIDES: Record<string, Activity | null> = {
  'speech-to-text': 'audio',
  'audio-to-text': 'audio',
  training: null,
  workflow: null,
  unknown: null,
}

/**
 * Target modality (from `<source>-to-<target>` category names) → activity.
 * Speech and music land in `audio`; image/video/audio-to-text (captioning,
 * visual QA) land in `chat` like other text generation. Target modalities
 * outside the shared taxonomy (`3d`, `json`, `vision`, …) have no activity
 * in our six-value enum and classify to null (PR #622 kept them as their own
 * sub-groups; our catalog drops them until the taxonomy grows).
 */
const FAL_MODALITY_ACTIVITIES: Record<string, Activity> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  speech: 'audio',
  music: 'audio',
  text: 'chat',
  llm: 'chat',
}

export function falCategoryActivity(category: string): Activity | null {
  const override = FAL_CATEGORY_OVERRIDES[category]
  if (override !== undefined) return override
  const modality = category.replace(/^.+-to-/, '')
  return FAL_MODALITY_ACTIVITIES[modality] ?? null
}

function classify(_path: string, op: OpenApiOperation): Activity | null {
  const marker = op[FAL_ACTIVITY_MARKER]
  if (
    typeof marker === 'string' &&
    (activities as ReadonlyArray<string>).includes(marker)
  ) {
    return marker as Activity
  }
  return null
}

async function fetchPageWithRetry(
  url: string,
  apiKey: string,
  retries = 3,
): Promise<FalApiResponse> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch(url, {
      headers: { Authorization: `Key ${apiKey}` },
    })
    if (response.status === 429 && attempt < retries) {
      const waitTime = Math.min(2000 * Math.pow(2, attempt), 10000)
      await new Promise((resolve) => setTimeout(resolve, waitTime))
      continue
    }
    if (!response.ok) {
      throw new Error(
        `fal models fetch failed: ${String(response.status)} ${response.statusText}`,
      )
    }
    return (await response.json()) as FalApiResponse
  }
  throw new Error('fal models fetch: max retries exceeded')
}

async function fetchFalModels(
  apiKey: string,
  expandOpenApi: boolean,
): Promise<Array<FalApiModel>> {
  const allModels: Array<FalApiModel> = []
  let cursor: string | null = null
  do {
    const params = new URLSearchParams({ status: 'active' })
    if (expandOpenApi) params.set('expand', 'openapi-3.0')
    if (cursor) params.set('cursor', cursor)
    const data = await fetchPageWithRetry(
      `${FAL_MODELS_URL}?${params.toString()}`,
      apiKey,
    )
    allModels.push(...data.models)
    cursor = data.has_more ? data.next_cursor : null
  } while (cursor)
  return allModels
}

function annotateOperations(spec: OpenApiDocument, activity: Activity): void {
  for (const operations of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(operations)) {
      op[FAL_ACTIVITY_MARKER] = activity
    }
  }
}

async function fetchSpec(env: ProviderSecrets): Promise<SpecFetchResult> {
  const apiKey = env.FAL_KEY
  if (!apiKey) {
    return {
      specs: [],
      outputStrategy: 'sibling-get',
      ...skippedResult('fal', 'FAL_KEY'),
    }
  }
  const models = await fetchFalModels(apiKey, true)
  const specs: Array<OpenApiDocument> = []
  for (const model of models) {
    if (!model.openapi) continue
    const activity = falCategoryActivity(model.metadata.category)
    if (activity === null) continue
    const spec = model.openapi
    // Stash endpointId on info for the merge step (per-endpoint schema
    // dedup-renaming), mirroring the PR's x-fal-metadata trick.
    spec.info ??= {}
    spec.info['x-fal-endpoint-id'] = model.endpoint_id
    annotateOperations(spec, activity)
    specs.push(spec)
  }
  return { specs, outputStrategy: 'sibling-get' }
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const apiKey = env.FAL_KEY
  if (!apiKey) {
    return { models: [], ...skippedResult('fal', 'FAL_KEY') }
  }
  const falModels = await fetchFalModels(apiKey, false)
  const models: Array<ModelInfo> = falModels.map((m) => ({
    rawId: m.endpoint_id,
    displayName: m.metadata.display_name ?? null,
    activity: falCategoryActivity(m.metadata.category),
    deprecated: m.metadata.status === 'deprecated',
    capabilities: { category: m.metadata.category },
  }))
  return { models }
}

export const falProvider: ProviderConfig = {
  id: 'fal',
  displayName: 'FAL',
  authEnvVar: 'FAL_KEY',
  fetchSpec,
  listModels,
  classify,
}
