/**
 * Azure OpenAI. Models and their facts come from two Microsoft Learn
 * articles, prices from the Azure Retail Prices API, and schemas from the
 * v1 OpenAPI document in Azure's REST API specs repo. All four are public.
 * Deployment lists on a resource need a key and are not called.
 */
import {
  AZURE_MODELS_URL,
  AZURE_REASONING_URL,
  azureModelInfo,
  parseAzureFeatureMatrix,
  parseAzureModels,
} from '../azure-models.ts'
import {
  AZURE_PRICES_URL,
  azureModelPricing,
  fetchAzurePrices,
} from '../azure-pricing.ts'
import { assertParsed, cachedDocs } from '../model-facts.ts'
import { classifyOpenAiCompat } from '../openai-compat.ts'
import { fetchOpenApi, fetchText, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const AZURE_SPEC_URL =
  'https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/specification/ai/data-plane/OpenAI.v1/azure-v1-v1-generated.json'

/** A Learn article as markdown, parsed, with the hash of what was read. */
function learnDoc<T>(
  kv: KVNamespace | undefined,
  url: string,
  parse: (markdown: string) => Map<string, T>,
): Promise<{ rows: Record<string, T>; hash: string }> {
  return cachedDocs(kv, url, async () => {
    const markdown = await fetchText(url, {
      headers: { Accept: 'text/markdown' },
    })
    const rows = parse(markdown)
    assertParsed(rows, `azure ${url}`)
    return { rows: Object.fromEntries(rows), hash: await sha256Text(markdown) }
  })
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const [models, matrix, prices] = await Promise.all([
    learnDoc(kv, AZURE_MODELS_URL, parseAzureModels),
    learnDoc(kv, AZURE_REASONING_URL, parseAzureFeatureMatrix),
    cachedDocs(kv, AZURE_PRICES_URL, fetchAzurePrices),
  ])
  const hashes = { models: models.hash, reasoning: matrix.hash }
  return {
    models: Object.values(models.rows).map((row) => {
      const info = azureModelInfo(row, matrix.rows[row.rawId], hashes)
      if (row.activity !== 'chat') return info
      const priced = azureModelPricing(prices, row.rawId, row.version)
      return {
        ...info,
        ...priced,
        factSources: { ...info.factSources, ...priced.factSources },
      }
    }),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchOpenApi(AZURE_SPEC_URL)
  return {
    specs: [spec],
    sources: [{ url: AZURE_SPEC_URL, hash }],
    outputStrategy: 'post-200',
    // Floating `main` URL: the document hash is the revision id.
    specRevision: hash,
  }
}

export const provider: ProviderConfig = {
  id: 'azure',
  // Azure OpenAI serves OpenAI models under OpenAI's ids; an id with no
  // OpenAI row simply stays unlinked.
  upstreamModelIdentity: (rawId) => ({
    providerNamespace: 'openai',
    rawId,
    source: {
      derivation: 'docs-derived',
      sourceUrl: AZURE_MODELS_URL,
      path: 'model id',
    },
  }),
  displayName: 'Azure OpenAI',
  specSourceUrl: AZURE_SPEC_URL,
  modelsEndpoint: AZURE_MODELS_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
}
