import { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ProviderConfig } from './types.ts'
import { parseGlmCodingModels } from './glm-coding-docs.ts'
import type { CodingDoc, CodingLocale } from './glm-coding-docs.ts'
import {
  applyReplay,
  parseGlmReplay,
  ZAI_THINKING_MODE_URL,
  ZHIPU_THINKING_MODE_URL,
} from './provider-replay.ts'

export interface CodingSources {
  overview: string
  latest: string
  thinking: string
  replay: string
}
export const ZAI_CODING_SOURCES: CodingSources = {
  overview: 'https://docs.z.ai/devpack/overview.md',
  latest: 'https://docs.z.ai/devpack/latest-model.md',
  thinking: 'https://docs.z.ai/guides/capabilities/thinking.md',
  replay: ZAI_THINKING_MODE_URL,
}
export const ZHIPU_CODING_SOURCES: CodingSources = {
  overview: 'https://docs.bigmodel.cn/cn/coding-plan/overview.md',
  latest: 'https://docs.bigmodel.cn/cn/coding-plan/latest-model.md',
  thinking: 'https://docs.bigmodel.cn/cn/guide/capabilities/thinking.md',
  replay: ZHIPU_THINKING_MODE_URL,
}
export function parseCodingReplay(
  doc: CodingDoc,
  locale: CodingLocale,
): Set<string> {
  const section = doc.text
    .split(/^## /m)
    .find((part) => /^(?:\*\*)?Preserved thinking|^保留式思考/.test(part))
  const prose =
    section?.replace(/\\_/g, '_').replace(/[*`]/g, '').replace(/\s+/g, ' ') ??
    ''
  const scoped =
    locale === 'en'
      ? /enabled by default.{0,80}Coding Plan endpoint/.test(prose) &&
        /must return the complete.{0,40}unmodified reasoning_content back to the API/.test(
          prose,
        )
      : /Coding Plan 端点默认开启/.test(prose) &&
        /需要将完整、未修改的 reasoning content 传回 API/.test(prose)
  if (!scoped)
    throw new Error('glm coding: no native Coding Plan replay contract')
  return new Set(parseGlmReplay(doc.text))
}
export function glmCodingProvider(
  id: string,
  displayName: string,
  locale: CodingLocale,
  urls: CodingSources,
): ProviderConfig {
  async function load(kv?: KVNamespace) {
    return cachedDocs(kv, urls.overview, async () => {
      const doc = async (url: string): Promise<CodingDoc> => {
        const text = await fetchText(url, {
          signal: AbortSignal.timeout(30_000),
        })
        return { url, text, hash: await sha256Text(text) }
      }
      const [overview, latest, thinking, replay] = await Promise.all([
        doc(urls.overview),
        doc(urls.latest),
        doc(urls.thinking),
        doc(urls.replay),
      ])
      return { overview, latest, thinking, replay }
    })
  }
  return {
    id,
    displayName,
    specSourceUrl: urls.latest,
    modelsEndpoint: urls.overview,
    defaultDerivation: 'docs-derived',
    bindSyncedRoutesOnly: true,
    async listModels(_env, kv) {
      const docs = await load(kv)
      const models = parseGlmCodingModels(docs, locale)
      const replayIds = parseCodingReplay(docs.replay, locale)
      return {
        models: models.map((model) =>
          replayIds.has(model.rawId)
            ? applyReplay(model, {
                derivation: 'docs-derived',
                sourceUrl: docs.replay.url,
                sourceHash: docs.replay.hash,
                path: 'Preserved thinking: Coding Plan reasoning_content replay',
              })
            : model,
        ),
      }
    },
    async fetchSpec() {
      const docs = await load()
      parseGlmCodingModels(docs, locale)
      parseCodingReplay(docs.replay, locale)
      return {
        specs: [],
        ...(id === 'zhipuai-coding-plan'
          ? {
              withdrawnSchemaSources: [
                'https://docs.bigmodel.cn/openapi/openapi.json',
              ],
            }
          : {}),
        sources: Object.values(docs).map((doc) => ({
          url: doc.url,
          hash: doc.hash,
        })),
        outputStrategy: 'post-200',
        skipped: `${id}: own Coding docs state model facts and effort controls, but publish no complete Coding request/response schema — skipped`,
      }
    },
    classify: () => null,
  }
}
