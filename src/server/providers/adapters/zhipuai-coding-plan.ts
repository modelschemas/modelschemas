/**
 * Zhipu AI Coding Plan — model ids named on the Coding Plan docs.
 * The overview lists the models every plan can call. The switch guide names
 * the ids. Its `glm-5.3-flash[1m]` is a model-name suffix Claude Code reads
 * to enable a 1M context, not a model id, so it is not listed. Point
 * coefficients are not USD, so prices stay null.
 *
 * Each model's facts come from Zhipu's China docs. Those are Z.AI's docs in
 * Chinese, so the Z.AI parsers read them with a Chinese wording: the chat
 * request that lists the id in the OpenAPI document gives the route, output
 * cap, input modalities and flags; the model overview table gives the
 * context window; the Deep Thinking page's "Coding Plan request" list gives
 * reasoning. A fact is looked up by the exact id.
 *
 * The OpenAPI document is the general platform's (`…/api/paas/v4`), and the
 * endpoint id is that pay-as-you-go path. The plan's OpenAI base URL is
 * `…/api/coding/paas/v4`. Zhipu publishes no document for it and no page
 * says the two take the same body; the plan docs only name the protocol,
 * "OpenAI Chat Completion". The binding rests on that, hence `docs-derived`.
 */
import {
  applyReplay,
  loadReplayDoc,
  parseGlmReplay,
  ZHIPU_THINKING_MODE_URL,
} from '../provider-replay.ts'
import type { Activity } from '#/db/schema.ts'

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
import {
  fetchZaiDoc,
  modelNames,
  namedBy,
  parseZaiContextWindows,
  zaiSpecFacts,
} from './zai.ts'
import type { GlmWording, ModelNames, ZaiDoc } from './zai.ts'

export const ZHIPU_CODING_OVERVIEW_URL =
  'https://docs.bigmodel.cn/cn/coding-plan/overview.md'
export const ZHIPU_CODING_MODELS_URL =
  'https://docs.bigmodel.cn/cn/coding-plan/latest-model.md'
export const ZHIPU_OPENAPI_URL = 'https://docs.bigmodel.cn/openapi/openapi.json'
export const ZHIPU_MODEL_OVERVIEW_URL =
  'https://docs.bigmodel.cn/cn/guide/start/model-overview.md'
export const ZHIPU_THINKING_URL =
  'https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md'

/** The document's async chat, image, video and audio routes are not the plan's. */
const CHAT_PATH = '/paas/v4/chat/completions'

/**
 * docs.bigmodel.cn wording. An "only these models" clause starts with a
 * model name ("仅限`GLM-5.3-Flash`系列…支持"); "仅文本模型支持此字段" names a
 * request variant, which the variant's own properties already express.
 */
export const ZHIPU_WORDING: GlmWording = {
  label: 'zhipuai-coding-plan',
  modelColumn: '模型',
  contextColumn: '上下文',
  supports: /最大支持/,
  cap: /^`(\d+(?:\.\d+)?[KM])`输出长度/,
  series: /系列\s*$/,
  filler: '系列|和|[，、]',
  supportedBy: /仅限?\s*(`(?:Auto)?GLM-.+?)支持/is,
  floor: /及其?以上/,
  floorFiller: '及其?以上|模型|系列',
}

interface ReasoningRow extends ModelNames {
  reasoning: ModelReasoning
}

const WIRE_ID = /`((?:glm)-[a-z0-9.-]+)`|"((?:glm)-[a-z0-9.-]+)"/g

function zhipuCodingIds(overview: string, latest: string): Array<string> {
  const ids = new Set<string>()
  for (const line of overview.split('\n')) {
    if (!line.includes('所有套餐均支持')) continue
    for (const name of line.match(/GLM-[A-Za-z0-9.-]+/g) ?? []) {
      ids.add(name.toLowerCase())
    }
  }
  for (const doc of [overview, latest]) {
    for (const match of doc.matchAll(WIRE_ID)) {
      const id = match[1] ?? match[2]
      if (id) ids.add(id)
    }
  }
  if (ids.size === 0) {
    throw new Error('zhipuai-coding-plan: docs listed no model ids')
  }
  return [...ids].sort()
}

/**
 * The "在 Coding Plan 请求中" bullets under `reasoning_effort` on the Deep
 * Thinking page: "针对 <models>，<values> 映射为 <level>；…". The efforts are
 * the levels a request ends up at. `none` mapped to a level means thinking
 * cannot stop; `none` under "代表模型放弃思考" means it can, and is itself an
 * effort. A line that places `none` nowhere gives no reasoning.
 */
export function parseZhipuCodingReasoning(
  markdown: string,
): Array<ReasoningRow> {
  const block = markdown.match(
    /在 Coding Plan 请求中[ \t]*\n((?:[ \t]+\* .*\n)+)/,
  )?.[1]
  if (block === undefined) {
    throw new Error(
      'zhipuai-coding-plan: Deep Thinking page has no Coding Plan reasoning_effort list',
    )
  }
  const rows: Array<ReasoningRow> = []
  for (const line of block.trimEnd().split('\n')) {
    const unreadable = () =>
      new Error(
        `zhipuai-coding-plan: unreadable reasoning_effort line: ${line.trim()}`,
      )
    const match = line.match(/^\s*\* 针对 ((?:`[^`]+`\s*)+)，(.+)$/)
    const names = modelNames(match?.[1] ?? '')
    if (!match?.[1] || !match[2]) throw unreadable()
    if (names.length !== match[1].trim().split(/\s+/).length) {
      throw unreadable()
    }
    const efforts = new Set<string>()
    let mandatory: boolean | null = null
    for (const text of match[2].split('；')) {
      const clause = text
        .trim()
        .match(
          /^(`[a-z]+`(?:(?:、| 或 | \/ )`[a-z]+`)*) (?:映射为 `([a-z]+)`|代表模型放弃思考)$/,
        )
      if (!clause?.[1]) throw unreadable()
      const values = [...clause[1].matchAll(/`([a-z]+)`/g)].flatMap((value) =>
        value[1] ? [value[1]] : [],
      )
      const level = clause[2]
      for (const effort of level ? [level] : values) efforts.add(effort)
      if (values.includes('none')) mandatory = level !== undefined
    }
    if (mandatory === null) continue
    rows.push({
      names,
      series: false,
      reasoning: { mode: 'effort', mandatory, efforts: [...efforts] },
    })
  }
  return rows
}

export function classifyZhipuCodingPath(path: string): Activity | null {
  return path === CHAT_PATH ? 'chat' : null
}

export function parseZhipuCodingModels(docs: {
  overview: ZaiDoc
  latest: ZaiDoc
  spec: ZaiDoc
  models: ZaiDoc
  thinking: ZaiDoc
}): Array<ModelInfo> {
  const ids = zhipuCodingIds(docs.overview.text, docs.latest.text)
  const only = (id: string) => ids.includes(id)
  const facts = zaiSpecFacts(JSON.parse(docs.spec.text), docs.spec, {
    wording: ZHIPU_WORDING,
    classify: classifyZhipuCodingPath,
    only,
  })
  const windows = parseZaiContextWindows(docs.models.text, ZHIPU_WORDING, only)
  const reasonings = parseZhipuCodingReasoning(docs.thinking.text)
  const from = (
    doc: ZaiDoc,
    derivation: FactSource['derivation'],
    path: string,
  ): FactSource => ({
    derivation,
    sourceUrl: doc.url,
    sourceHash: doc.hash,
    path,
  })
  return ids.map((rawId) => {
    const fact = facts.get(rawId)
    const contextWindow = windows.get(rawId) ?? null
    const reasoning = namedBy(rawId, reasonings)?.reasoning ?? null
    // No effort list for the model means no `reasoning_effort` flag either.
    const capabilities = fact?.capabilities
      ? Object.fromEntries(
          Object.entries(fact.capabilities).filter(
            ([flag]) => flag !== 'reasoning_effort' || reasoning !== null,
          ),
        )
      : null
    const factSources: ModelFactSources = {
      ...(contextWindow !== null
        ? { contextWindow: from(docs.models, 'docs-derived', '上下文') }
        : {}),
      ...(reasoning
        ? {
            reasoning: from(docs.thinking, 'docs-derived', 'reasoning_effort'),
          }
        : {}),
      ...(capabilities && Object.keys(capabilities).length > 0
        ? { capabilities }
        : {}),
      ...(fact?.maxOutput != null
        ? { maxOutput: from(docs.spec, 'upstream-spec', 'max_tokens') }
        : {}),
      ...(fact?.modalities
        ? { modalities: from(docs.spec, 'upstream-spec', 'messages') }
        : {}),
    }
    return {
      rawId,
      pricing: null,
      ...(fact
        ? {
            activity: fact.activity,
            schemaEndpointId: fact.schemaEndpointId,
            maxOutput: fact.maxOutput,
            modalities: fact.modalities,
          }
        : {}),
      ...(capabilities
        ? { capabilities: Object.keys(capabilities), exactCapabilities: true }
        : {}),
      ...(contextWindow !== null ? { contextWindow } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(Object.keys(factSources).length > 0 ? { factSources } : {}),
    }
  })
}

async function listModels(_env: ProviderSecrets): Promise<ListModelsResult> {
  const doc = (url: string) => fetchZaiDoc(url, ZHIPU_WORDING.label)
  const [overview, latest, spec, models, thinking] = await Promise.all([
    doc(ZHIPU_CODING_OVERVIEW_URL),
    doc(ZHIPU_CODING_MODELS_URL),
    doc(ZHIPU_OPENAPI_URL),
    doc(ZHIPU_MODEL_OVERVIEW_URL),
    doc(ZHIPU_THINKING_URL),
  ])
  const replay = await loadReplayDoc(ZHIPU_THINKING_MODE_URL)
  const replayIds = new Set(parseGlmReplay(replay.text))
  return {
    models: parseZhipuCodingModels({
      overview,
      latest,
      spec,
      models,
      thinking,
    }).map((model) =>
      replayIds.has(model.rawId) && model.activity === 'chat'
        ? applyReplay(model, replay.source)
        : model,
    ),
  }
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { text, hash } = await fetchZaiDoc(
    ZHIPU_OPENAPI_URL,
    ZHIPU_WORDING.label,
  )
  return {
    specs: [JSON.parse(text) as OpenApiDocument],
    sources: [{ url: ZHIPU_OPENAPI_URL, hash }],
    outputStrategy: 'post-200',
    specRevision: hash,
  }
}

export const provider: ProviderConfig = {
  id: 'zhipuai-coding-plan',
  displayName: 'Zhipu AI Coding Plan',
  specSourceUrl: ZHIPU_OPENAPI_URL,
  modelsEndpoint: ZHIPU_CODING_MODELS_URL,
  defaultDerivation: 'docs-derived',
  fetchSpec,
  listModels,
  classify: (path) => classifyZhipuCodingPath(path),
  // A poll can run before the first sync has stored the chat route.
  bindSyncedRoutesOnly: true,
}
