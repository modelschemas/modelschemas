/**
 * Moonshot AI (China). platform.moonshot.cn redirects to platform.kimi.com,
 * whose OpenAPI document names api.moonshot.cn as its server. Model ids and
 * context windows come from the pricing page; activity, reasoning and
 * modalities from the spec's per-model chat request schemas. Output is
 * capped by the context window; no separate limit is published.
 * Prices on the pricing page are yuan. Rate cards are USD, so prices stay
 * null. `GET /v1/models` needs a CN key, which is region-bound.
 */
import { classifyOpenAiCompat } from '../openai-compat.ts'
import { cachedDocs } from '../model-facts.ts'
import { compatGenerationEndpointId } from '../model-meta.ts'
import { REASONING_SOURCE_SILENT } from '../reasoning-config.ts'
import { fetchText, sha256Text } from '../types.ts'
import type {
  FactSource,
  ListModelsResult,
  ModelFactSources,
  ModelInfo,
  ModelReasoning,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const MOONSHOT_CN_PRICING_URL =
  'https://platform.kimi.com/docs/pricing/chat.md'
export const MOONSHOT_CN_OPENAPI_URL =
  'https://platform.kimi.com/docs/openapi.json'

const CN_SERVER = 'https://api.moonshot.cn'
const CHAT_PATH = '/v1/chat/completions'
const FETCH_TIMEOUT_MS = 20_000

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseMoonshotCnModels(markdown: string): Array<ModelInfo> {
  const models: Array<ModelInfo> = []
  const seen = new Set<string>()
  for (const match of markdown.matchAll(
    /\["((?:kimi|moonshot)-[^"]+)"([\s\S]*?)\]/g,
  )) {
    const rawId = match[1]
    const body = match[2] ?? ''
    if (!rawId || seen.has(rawId)) continue
    seen.add(rawId)
    const windows = [...body.matchAll(/"([0-9,]+) tokens"/g)]
    const last = windows.at(-1)?.[1]
    const contextWindow = last ? Number(last.replace(/,/g, '')) : null
    models.push({
      rawId,
      contextWindow:
        contextWindow !== null && Number.isFinite(contextWindow)
          ? contextWindow
          : null,
      pricing: null,
    })
  }
  if (models.length === 0) {
    throw new Error('moonshotai-cn: pricing page listed no ids')
  }
  return models
}

function deref(spec: OpenApiDocument, node: unknown, depth = 0): unknown {
  if (depth > 8 || !isRecord(node) || typeof node.$ref !== 'string') return node
  const name = node.$ref.replace('#/components/schemas/', '')
  return deref(spec, spec.components?.schemas?.[name], depth + 1)
}

/** Own and `allOf` properties. `oneOf` branches are alternatives, not merged. */
function propertiesOf(spec: OpenApiDocument, node: unknown): Json {
  const resolved = deref(spec, node)
  if (!isRecord(resolved)) return {}
  const out: Json = {}
  if (Array.isArray(resolved.allOf)) {
    for (const part of resolved.allOf) {
      Object.assign(out, propertiesOf(spec, part))
    }
  }
  return {
    ...out,
    ...(isRecord(resolved.properties) ? resolved.properties : {}),
  }
}

function stringEnum(node: unknown): Array<string> {
  if (!isRecord(node) || !Array.isArray(node.enum)) return []
  return node.enum.filter((item): item is string => typeof item === 'string')
}

const PART_MODALITY: Record<string, string> = {
  text: 'text',
  image_url: 'image',
  video_url: 'video',
}

/** Content part names (`image_url`, …) anywhere under a messages schema. */
function partModalities(
  spec: OpenApiDocument,
  node: unknown,
  into: Set<string>,
  depth = 0,
): void {
  const resolved = deref(spec, node)
  if (depth > 12 || typeof resolved !== 'object' || resolved === null) return
  for (const [key, value] of Object.entries(resolved)) {
    const modality = PART_MODALITY[key]
    if (modality) into.add(modality)
    partModalities(spec, value, into, depth + 1)
  }
}

export type MoonshotChatFacts = Pick<
  ModelInfo,
  'activity' | 'reasoning' | 'capabilities' | 'modalities'
> & { factSources: ModelFactSources }

/**
 * Per-model facts from the chat request union, keyed by the ids in its
 * `model` discriminator. Throws when the document is not the CN chat spec.
 */
export function moonshotCnChatFacts(
  spec: OpenApiDocument,
  hash: string,
): Record<string, MoonshotChatFacts> {
  if (spec.servers?.[0]?.url !== CN_SERVER) {
    throw new Error(`moonshotai-cn: spec server is not ${CN_SERVER}`)
  }
  const post = spec.paths?.[CHAT_PATH]?.post
  const body = isRecord(post?.requestBody) ? post.requestBody : {}
  const content = isRecord(body.content) ? body.content : {}
  const media = content['application/json']
  const schema = isRecord(media) && isRecord(media.schema) ? media.schema : {}
  const discriminator = isRecord(schema.discriminator)
    ? schema.discriminator
    : {}
  const mapping = isRecord(discriminator.mapping) ? discriminator.mapping : {}
  if (discriminator.propertyName !== 'model') {
    throw new Error('moonshotai-cn: chat request is not a per-model union')
  }

  const out: Record<string, MoonshotChatFacts> = {}
  for (const [rawId, ref] of Object.entries(mapping)) {
    if (typeof ref !== 'string') continue
    const name = ref.replace('#/components/schemas/', '')
    const props = propertiesOf(spec, { $ref: ref })
    if (!stringEnum(props.model).includes(rawId)) continue
    const source = (path: string): FactSource => ({
      derivation: 'upstream-spec',
      sourceUrl: MOONSHOT_CN_OPENAPI_URL,
      sourceHash: hash,
      path,
    })
    const facts: MoonshotChatFacts = { activity: 'chat', factSources: {} }

    const efforts = stringEnum(props.reasoning_effort)
    const thinking = stringEnum(propertiesOf(spec, props.thinking).type)
    if (efforts.length > 0) {
      const reasoning: ModelReasoning = {
        mode: 'effort',
        mandatory: !efforts.includes('none') && !thinking.includes('disabled'),
        efforts,
      }
      const effortSource = source(
        `/components/schemas/${name}/properties/reasoning_effort`,
      )
      facts.reasoning = reasoning
      facts.factSources.reasoning = effortSource
      // The schema walk flags `reasoning` only for a `thinking` property.
      facts.capabilities = ['reasoning']
      facts.factSources.capabilities = { reasoning: effortSource }
    } else if (thinking.length > 0) {
      // An on/off `thinking.type` names no mode `ModelReasoning` can hold.
      facts.factSources.reasoning = source(REASONING_SOURCE_SILENT)
    }

    const input = new Set<string>()
    partModalities(spec, props.messages, input)
    if (input.size > 0) {
      facts.modalities = { input: [...input], output: ['text'] }
      facts.factSources.modalities = source(
        `/components/schemas/${name}/properties/messages`,
      )
    }
    out[rawId] = facts
  }
  if (Object.keys(out).length === 0) {
    throw new Error('moonshotai-cn: chat spec mapped no model ids')
  }
  return out
}

async function fetchCnSpec(): Promise<{ spec: OpenApiDocument; hash: string }> {
  const text = await fetchText(MOONSHOT_CN_OPENAPI_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  // An unknown docs path answers 200 with another page; JSON.parse throws on it.
  const spec = JSON.parse(text) as OpenApiDocument
  return { spec, hash: await sha256Text(text) }
}

async function listModels(
  _env: ProviderSecrets,
  kv?: KVNamespace,
): Promise<ListModelsResult> {
  const markdown = await fetchText(MOONSHOT_CN_PRICING_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const pricingHash = await sha256Text(markdown)
  const chat = await cachedDocs(kv, MOONSHOT_CN_OPENAPI_URL, async () => {
    const { spec, hash } = await fetchCnSpec()
    return moonshotCnChatFacts(spec, hash)
  })
  const models = parseMoonshotCnModels(markdown).map((model): ModelInfo => {
    const facts = chat[model.rawId]
    const factSources: ModelFactSources = { ...facts?.factSources }
    if (model.contextWindow != null) {
      factSources.contextWindow = {
        derivation: 'docs-derived',
        sourceUrl: MOONSHOT_CN_PRICING_URL,
        sourceHash: pricingHash,
        path: 'contextWindow',
      }
    }
    return { ...model, ...facts, factSources }
  })
  return { models }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { spec, hash } = await fetchCnSpec()
  moonshotCnChatFacts(spec, hash)
  return {
    specs: [spec],
    sources: [{ url: MOONSHOT_CN_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
  }
}

export const provider: ProviderConfig = {
  id: 'moonshotai-cn',
  displayName: 'Moonshot AI (China)',
  specSourceUrl: MOONSHOT_CN_OPENAPI_URL,
  modelsEndpoint: MOONSHOT_CN_PRICING_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify: classifyOpenAiCompat,
  generationEndpointId: ({ activity }) =>
    compatGenerationEndpointId(activity, 'v1/'),
}
