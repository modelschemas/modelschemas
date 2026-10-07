/**
 * SambaNova Cloud — OpenAI-compatible chat API. hints.json's docs URL
 * 404s and the Stainless SDK publishes no openapi_spec_url, so endpoint
 * schemas stay generated from the OpenAI document. That document is not
 * the request map. Modalities and capability flags are read from
 * SambaNova's models page, function-calling page, and inference OpenAPI.
 */
import { perTokenListingCard } from '../catalog-prices.ts'
import { overlayModelFacts } from '../reasoning-config.ts'
import { assertParsed, docsReport, docsRun, tryDocs } from '../model-facts.ts'
import {
  SAMBANOVA_MODELS_DOCS_URL,
  SAMBANOVA_SPEC_URL,
  SAMBANOVA_TOOLS_DOCS_URL,
  parseSambanovaChatFlags,
  parseSambanovaModelModalities,
  parseSambanovaToolModels,
  sambanovaDocsPatch,
} from '../sambanova-docs.ts'
import type { SambanovaDocsLoad } from '../sambanova-docs.ts'
import {
  OPENAI_OPENAPI_URL,
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
  listOpenAiCompatibleModels,
} from '../openai-compat.ts'
import {
  compatGenerationEndpointId,
  sambanovaModelActivity,
} from '../model-meta.ts'
import { fetchText, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const MODELS_URL = 'https://api.sambanova.ai/v1/models'
const SERVER_URL = 'https://api.sambanova.ai/v1'

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'SambaNova',
    serverUrl: SERVER_URL,
    include: ['/chat/completions'],
  })
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
  }
}

async function loadDocs(kv: KVNamespace | undefined): Promise<{
  loaded: SambanovaDocsLoad
  failures: ListModelsResult['docsFailures']
}> {
  const docs = docsRun()
  const [modalities, flags, tools] = await Promise.all([
    tryDocs(docs, SAMBANOVA_MODELS_DOCS_URL, (cached) =>
      cached(kv, SAMBANOVA_MODELS_DOCS_URL, async () => {
        const markdown = await fetchText(SAMBANOVA_MODELS_DOCS_URL)
        const rows = parseSambanovaModelModalities(markdown)
        assertParsed(rows, SAMBANOVA_MODELS_DOCS_URL)
        return {
          byId: Object.fromEntries(rows),
          hash: await sha256Text(markdown),
        }
      }),
    ),
    tryDocs(docs, SAMBANOVA_SPEC_URL, (cached) =>
      cached(kv, SAMBANOVA_SPEC_URL, async () => {
        const text = await fetchText(SAMBANOVA_SPEC_URL)
        return {
          flags: parseSambanovaChatFlags(JSON.parse(text) as unknown),
          hash: await sha256Text(text),
        }
      }),
    ),
    tryDocs(docs, SAMBANOVA_TOOLS_DOCS_URL, (cached) =>
      cached(kv, SAMBANOVA_TOOLS_DOCS_URL, async () => {
        const markdown = await fetchText(SAMBANOVA_TOOLS_DOCS_URL)
        const ids = parseSambanovaToolModels(markdown)
        assertParsed(
          new Map([...ids].map((id) => [id, true])),
          SAMBANOVA_TOOLS_DOCS_URL,
        )
        return { ids: [...ids], hash: await sha256Text(markdown) }
      }),
    ),
  ])
  const report = docsReport(docs)
  return {
    loaded: { modalities, flags, tools },
    failures: report.failed + report.skipped > 0 ? report : undefined,
  }
}

async function listModels(
  env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const listed = await listOpenAiCompatibleModels({
    providerId: 'sambanova',
    url: MODELS_URL,
    env,
    envVar: 'SAMBANOVA_API_KEY',
    activity: sambanovaModelActivity,
    extend: async (row) => {
      // `input_cache_read` is the billed cached-input rate. Omitted (the
      // pricing page says N/A) or zero stays off the card.
      const pricing = await perTokenListingCard(row.pricing, MODELS_URL)
      return pricing ? { pricing } : {}
    },
  })
  if (listed.skipped || listed.models.length === 0) return listed
  const { loaded, failures } = await loadDocs(kv)
  return {
    models: listed.models.map((model) =>
      overlayModelFacts(model, sambanovaDocsPatch(model.rawId, loaded)),
    ),
    ...(failures ? { docsFailures: failures } : {}),
  }
}

export const provider: ProviderConfig = {
  id: 'sambanova',
  displayName: 'SambaNova',
  authEnvVar: 'SAMBANOVA_API_KEY',
  specSourceUrl: OPENAI_OPENAPI_URL,
  modelsEndpoint: MODELS_URL,
  defaultDerivation: 'generated',
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
  generationEndpointId: ({ activity }) => compatGenerationEndpointId(activity),
}
