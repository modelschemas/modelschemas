/**
 * Fireworks AI — official text-completion OpenAPI at
 * docs.fireworks.ai/text-completion.openapi.yaml (public). The hinted
 * api-reference page is HTML, not a spec; the published YAML covers
 * POST /v1/chat/completions and /v1/completions. Models list needs
 * FIREWORKS_API_KEY.
 *
 * Prices, reasoning, and the chat request map are read on each poll from
 * the pricing page, the serverless models API, and that same YAML.
 */
import type { Activity } from '#/db/schema.ts'
import {
  applyFireworksDocs,
  FIREWORKS_SERVERLESS_URL,
  FIREWORKS_SPEC_URL,
  loadFireworksChatSpec,
  loadFireworksServerless,
  mergeFireworksRates,
} from '../fireworks-facts.ts'
import {
  FIREWORKS_PRICING_URL,
  loadFireworksPricingDoc,
} from '../fireworks-pricing.ts'
import { docsReport, docsRun, tryDocs } from '../model-facts.ts'
import {
  compatGenerationEndpointId,
  fireworksModalities,
  fireworksModelActivity,
} from '../model-meta.ts'
import {
  classifyOpenAiCompat,
  listOpenAiCompatibleModels,
} from '../openai-compat.ts'
import { overlayModelFacts } from '../reasoning-config.ts'
import { fetchOpenApi } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const FIREWORKS_MODELS_URL = 'https://api.fireworks.ai/inference/v1/models'

/**
 * Inference paths may be served under /inference (docs) or as the OpenAI
 * /v1-prefixed forms in the published spec. Anthropic-compatible /messages
 * is chat; rerank and the account control plane are platform.
 */
function classify(path: string): Activity | null {
  const stripped = path.startsWith('/inference/')
    ? path.slice('/inference'.length)
    : path
  const activity = classifyOpenAiCompat(stripped)
  if (activity) return activity
  const bare = stripped.startsWith('/v1/') ? stripped.slice(3) : stripped
  if (bare === '/messages') return 'chat'
  return null
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(FIREWORKS_SPEC_URL)
  return {
    specs: [spec],
    sources: [{ url: FIREWORKS_SPEC_URL, hash }],
    outputStrategy: 'post-200',
  }
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const listed = await listOpenAiCompatibleModels({
    providerId: 'fireworks',
    url: FIREWORKS_MODELS_URL,
    env,
    envVar: 'FIREWORKS_API_KEY',
    activity: fireworksModelActivity,
    extend: async (row) => {
      const modalities = fireworksModalities(row)
      const stated =
        typeof row.context_length === 'number' && row.context_length > 0
      return {
        ...(modalities ? { modalities } : {}),
        ...(stated
          ? {
              factSources: {
                contextWindow: {
                  derivation: 'listing' as const,
                  sourceUrl: FIREWORKS_MODELS_URL,
                  path: 'context_length',
                },
              },
            }
          : {}),
      }
    },
  })
  if (listed.models.length === 0) return listed
  const docs = docsRun()
  const key = env.FIREWORKS_API_KEY
  const markdown = await tryDocs(docs, FIREWORKS_PRICING_URL, (cached) =>
    loadFireworksPricingDoc(kv, cached),
  )
  const serverless = key
    ? await tryDocs(docs, FIREWORKS_SERVERLESS_URL, (cached) =>
        loadFireworksServerless(kv, cached, key),
      )
    : null
  const chat = await tryDocs(docs, FIREWORKS_SPEC_URL, (cached) =>
    loadFireworksChatSpec(kv, cached),
  )
  const prices = mergeFireworksRates(markdown, serverless)
  const context = serverless?.context ?? {}
  return {
    ...listed,
    models: listed.models.map((model) =>
      overlayModelFacts(
        model,
        applyFireworksDocs(model, {
          prices,
          context,
          contextHash: serverless?.hash ?? null,
          chat,
        }),
      ),
    ),
    docsFailures: docsReport(docs),
  }
}

export const provider: ProviderConfig = {
  id: 'fireworks',
  displayName: 'Fireworks AI',
  authEnvVar: 'FIREWORKS_API_KEY',
  specSourceUrl: FIREWORKS_SPEC_URL,
  modelsEndpoint: FIREWORKS_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
  generationEndpointId: ({ activity }) =>
    activity === 'embeddings'
      ? null
      : compatGenerationEndpointId(activity, 'v1/'),
  // The shared chat schema lists `reasoning_effort` on every model.
  // Fireworks names the families that accept it in that field's
  // description. The walk must not stamp `reasoning` on the rest.
  perModelSchemaFlags: ['reasoning', 'reasoning_effort'],
}
