/**
 * Amazon Bedrock — first-party only (issue #153). Models come from the user
 * guide's model cards; the Converse schema is generated from the AWS SDK's
 * Bedrock Runtime service model. Neither needs AWS credentials
 * (ListFoundationModels does), and no aggregator is read.
 */
import type { Activity } from '#/db/schema.ts'

import {
  BEDROCK_CARDS_URL,
  BEDROCK_CONVERSE_PATH,
  bedrockCardModels,
} from '../bedrock-cards.ts'
import {
  BEDROCK_SDK_MODEL_URL,
  bedrockConverseSpec,
} from '../bedrock-sdk-spec.ts'
import type { BedrockServiceModel } from '../bedrock-sdk-spec.ts'
import { bearerConnect } from '../connect.ts'
import { fetchText, sha256Text } from '../types.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const text = await fetchText(BEDROCK_SDK_MODEL_URL)
  const hash = await sha256Text(text)
  return {
    specs: [bedrockConverseSpec(JSON.parse(text) as BedrockServiceModel)],
    sources: [{ url: BEDROCK_SDK_MODEL_URL, hash }],
    outputStrategy: 'post-200',
    specRevision: hash,
  }
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  return { models: await bedrockCardModels(kv) }
}

export const provider: ProviderConfig = {
  id: 'amazon-bedrock',
  displayName: 'Amazon Bedrock',
  specSourceUrl: BEDROCK_SDK_MODEL_URL,
  modelsEndpoint: BEDROCK_CARDS_URL,
  defaultDerivation: 'generated',
  // A Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`); SigV4 also works.
  connect: bearerConnect(
    'https://bedrock-runtime.us-east-1.amazonaws.com',
    'Regional: replace us-east-1 with the Region you call.',
  ),
  fetchSpec,
  listModels,
  classify: (path): Activity | null =>
    path === BEDROCK_CONVERSE_PATH ? 'chat' : null,
}
