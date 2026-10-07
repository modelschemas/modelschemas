/**
 * Novita AI — OpenAI-compatible chat + image. No schema-bearing spec
 * (docs.novita.ai/openapi.json is HTML; novita.ai/.well-known/openapi.json
 * is a path-only discovery stub). Generated from the OpenAI document.
 * Official host is api.novita.ai/openai/v1 (the older /v3/openai prefix
 * still appears in some clients).
 */
import { novitaListingCard, novitaTieredCard } from '../catalog-prices.ts'
import { docsReport, docsRun } from '../model-facts.ts'
import {
  compatGenerationEndpointId,
  novitaModelActivity,
} from '../model-meta.ts'
import { loadNovitaDocs } from '../novita-facts.ts'
import {
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
  listOpenAiCompatibleModels,
  OPENAI_OPENAPI_URL,
} from '../openai-compat.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const NOVITA_SERVER_URL = 'https://api.novita.ai/openai/v1'
const NOVITA_MODELS_URL = 'https://api.novita.ai/openai/v1/models'

const INCLUDE = ['/chat/completions', '/images/generations'] as const

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'Novita AI',
    serverUrl: NOVITA_SERVER_URL,
    include: INCLUDE,
  })
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
  }
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const listed = await listOpenAiCompatibleModels({
    providerId: 'novita',
    url: NOVITA_MODELS_URL,
    env,
    envVar: 'NOVITA_API_KEY',
    activity: novitaModelActivity,
    extend: async (row) => {
      const pricing = row.is_tiered_billing
        ? await novitaTieredCard(row.tiered_billing_configs, NOVITA_MODELS_URL)
        : await novitaListingCard(row.pricing, false, NOVITA_MODELS_URL)
      if (!pricing) return {}
      return {
        pricing,
        factSources: {
          pricing: {
            derivation: 'listing',
            sourceUrl: NOVITA_MODELS_URL,
            sourceHash: pricing.source.hash,
            path: row.is_tiered_billing ? 'tiered_billing_configs' : 'pricing',
          },
        },
      }
    },
  })
  if (listed.skipped || listed.models.length === 0) return listed
  const docs = docsRun()
  const models = await loadNovitaDocs(
    docs,
    kv,
    NOVITA_MODELS_URL,
    listed.models,
  )
  return { ...listed, models, docsFailures: docsReport(docs) }
}

export const provider: ProviderConfig = {
  id: 'novita',
  displayName: 'Novita AI',
  authEnvVar: 'NOVITA_API_KEY',
  specSourceUrl: OPENAI_OPENAPI_URL,
  modelsEndpoint: NOVITA_MODELS_URL,
  defaultDerivation: 'generated',
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
  generationEndpointId: ({ activity }) =>
    activity === 'chat' || activity === 'image'
      ? compatGenerationEndpointId(activity)
      : null,
}
