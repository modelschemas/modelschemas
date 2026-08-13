/**
 * Alibaba Cloud Model Studio (DashScope) — OpenAI-compatible mode.
 * No published OpenAPI; schemas are generated from OpenAI's spec.
 * Intl host; China is dashscope.aliyuncs.com.
 */
import {
  classifyOpenAiCompat,
  fetchOpenAiCompatibleSpec,
  listOpenAiCompatibleModels,
} from '../openai-compat.ts'
import type { OpenAiCompatPath } from '../openai-compat.ts'
import type {
  ListModelsResult,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

const SPEC_SOURCE_URL =
  'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope'
const MODELS_URL =
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models'
const SERVER_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'

const INCLUDE: ReadonlyArray<OpenAiCompatPath> = [
  '/chat/completions',
  '/embeddings',
  '/images/generations',
  '/audio/speech',
  '/audio/transcriptions',
]

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, url, hash } = await fetchOpenAiCompatibleSpec({
    title: 'Alibaba Cloud Model Studio',
    serverUrl: SERVER_URL,
    include: INCLUDE,
  })
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
  }
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  return listOpenAiCompatibleModels({
    providerId: 'dashscope',
    url: MODELS_URL,
    env,
    envVar: 'DASHSCOPE_API_KEY',
  })
}

export const provider: ProviderConfig = {
  id: 'dashscope',
  displayName: 'Alibaba Cloud Model Studio',
  authEnvVar: 'DASHSCOPE_API_KEY',
  specSourceUrl: SPEC_SOURCE_URL,
  modelsEndpoint: MODELS_URL,
  defaultDerivation: 'generated',
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
}
