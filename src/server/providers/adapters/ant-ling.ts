/** Dynamic direct Ant Ling facts; never reseller prices or borrowed schemas. */
import { cachedDocs } from '../model-facts.ts'
import { tagDocsFacts } from '../fact-sources.ts'
import { bearerConnect } from '../connect.ts'
import { fetchText, sha256Text } from '../types.ts'
import { SHARED_EFFORT_LEVELS } from '../request-map.ts'
import type { ChatRequestMap, EffortLevelMap } from '../request-map.ts'
import type { ModelInfo, ProviderConfig } from '../types.ts'
import {
  ANT_OPENAI,
  ANT_OVERVIEW,
  ANT_PRICE,
  ANT_LING,
  ANT_RING,
  ANT_EFFORT,
  text,
  article,
  controls,
  blocks,
  overviewContextIds,
  antModelRows,
  nativeModelIds,
  nativePrices,
  priceCards,
  nativeContexts,
  nativeFields,
  nativeRequest,
  antSpec,
} from '../ant-ling-docs.ts'

async function load(url: string, kv?: KVNamespace) {
  return cachedDocs(kv, `ant-ling:${url}`, async () => {
    const html = await fetchText(url, { signal: AbortSignal.timeout(30_000) })
    return { html, hash: await sha256Text(html) }
  })
}
export const provider: ProviderConfig = {
  id: 'ant-ling',
  displayName: 'Ant Ling',
  specSourceUrl: ANT_OPENAI,
  modelsEndpoint: ANT_PRICE,
  defaultDerivation: 'docs-derived',
  bindSyncedRoutesOnly: true,
  connect: bearerConnect('https://api.ant-ling.com'),
  async listModels(_env, kv) {
    const [api, overview, pricing, ling, ring, effort] = await Promise.all(
      [ANT_OPENAI, ANT_OVERVIEW, ANT_PRICE, ANT_LING, ANT_RING, ANT_EFFORT].map(
        (url) => load(url, kv),
      ),
    )
    if (!api || !overview || !pricing || !ling || !ring || !effort)
      throw new Error('ant-ling: missing loaded source')
    const overviewIds = overviewContextIds(overview.html)
    const contexts = nativeContexts(overview.html, ling.html)
    const quotes = nativePrices(pricing.html)
    const cards = priceCards(quotes, {
      url: ANT_PRICE,
      hash: pricing.hash,
      extractedAt: new Date().toISOString(),
    })
    const control = controls(api.html)
    const fields = nativeFields(api.html)
    const schema = nativeRequest(api.html)
    const properties = schema.properties as Record<string, unknown>
    const role = fields.get('messages.role')
    if (!role) throw new Error('ant-ling: missing native role declaration')
    const apiIds = new Set(nativeModelIds(api.html))
    const nativePaths = Object.keys(antSpec(api.html).paths)
    if (nativePaths.length !== 1 || !nativePaths[0])
      throw new Error('ant-ling: unreadable native API route')
    const nativeEndpointId = nativePaths[0].replace(/^\//, '')
    const apiOverview = text(article(overview.html))
    const multimodal = text(fields.get('model') ?? '').match(
      /When using ([\w.-]+)\s*, the request accepts text, images, and videos/,
    )?.[1]
    if (!multimodal)
      throw new Error('ant-ling: missing native multimodal applicability')
    const levels = Object.fromEntries(
      SHARED_EFFORT_LEVELS.map((level) => [
        level,
        control.efforts.includes(level) ? level : null,
      ]),
    ) as EffortLevelMap
    const toggleOn = control.toggles.find((v) => v === 'enabled')
    const toggleOff = control.toggles.find((v) => v === 'disabled')
    if (
      !toggleOn ||
      !toggleOff ||
      !control.efforts.length ||
      !control.effortDefault ||
      !control.efforts.includes(control.effortDefault)
    )
      throw new Error('ant-ling: unreadable native control values')
    if (!text(article(effort.html)).includes(control.effortId))
      throw new Error('ant-ling: effort source model disagreement')
    const map: ChatRequestMap = {
      thinking: null,
      maxTokensField: 'max_tokens' in properties ? 'max_tokens' : null,
      developerRole: text(role).includes('developer') ? null : false,
      replayReasoningContent: null,
      store: null,
      strictTools: null,
      sessionAffinity: null,
      cacheControl: null,
      toolStream: null,
      reasoningEffort: null,
    }
    return {
      models: antModelRows(api.html, pricing.html, contexts).map(
        (model): ModelInfo => {
          const hasEffort = model.rawId === control.effortId
          const hasToggle = model.rawId === control.toggleId
          const reasoning = hasEffort
            ? {
                mode: 'effort' as const,
                mandatory: null,
                efforts: control.efforts,
              }
            : hasToggle
              ? { mode: 'toggle' as const, mandatory: false }
              : null
          const thinking = hasEffort
            ? {
                on: { reasoning: { effort: control.effortDefault } },
                off: null,
                levels,
              }
            : hasToggle
              ? {
                  on: { thinking: { type: toggleOn } },
                  off: { thinking: { type: toggleOff } },
                  levels: null,
                }
              : null
          const declaredText =
            apiIds.has(model.rawId) && apiOverview.includes('Text Conversation')
          // Text-only rows are sourced from the native text-conversation scope;
          // a newer price-only ID has no API-scoped modality statement yet.
          const modalities = declaredText
            ? {
                input:
                  model.rawId === multimodal
                    ? ['text', 'image', 'video']
                    : ['text'],
                output: ['text'],
              }
            : null
          const lingDetail = text(
            blocks(article(ling.html)).get(model.rawId) ?? '',
          )
          const capabilities = declaredText
            ? ['tools', ...(reasoning ? ['reasoning'] : [])]
            : /tool calling/.test(lingDetail)
              ? [
                  'tools',
                  ...(/hybrid reasoning/.test(lingDetail) ? ['reasoning'] : []),
                ]
              : null
          const requestMap = apiIds.has(model.rawId)
            ? { ...map, thinking }
            : null
          const facts = {
            ...model,
            modalities,
            capabilities,
            pricing: cards.get(model.rawId) ?? null,
            absent: cards.has(model.rawId)
              ? undefined
              : { pricing: 'cleared' as const },
            schemaEndpointId: apiIds.has(model.rawId) ? nativeEndpointId : null,
            reasoning,
            requestMap,
          }
          const contextUrl = overviewIds.has(model.rawId)
            ? ANT_OVERVIEW
            : ANT_LING
          const contextHash =
            contextUrl === ANT_OVERVIEW ? overview.hash : ling.hash
          return {
            ...facts,
            providerMetadata: {
              ...(quotes.has(model.rawId)
                ? {
                    directQuote: quotes.get(model.rawId)?.free
                      ? 'currently-free'
                      : 'paid',
                  }
                : {}),
              ...(model.rawId === control.effortId
                ? { nativeReasoningModelSource: ANT_RING }
                : {}),
            },
            factSources: {
              ...(apiIds.has(model.rawId)
                ? {
                    schemaEndpointId: {
                      derivation: 'docs-derived' as const,
                      sourceUrl: ANT_OPENAI,
                      sourceHash: api.hash,
                      path: 'Request Address + model.Options',
                    },
                  }
                : {}),
              ...tagDocsFacts(
                { contextWindow: model.contextWindow },
                contextUrl,
                contextHash,
              ),
              ...tagDocsFacts({ modalities, reasoning }, ANT_OPENAI, api.hash),
              ...(capabilities
                ? tagDocsFacts(
                    { capabilities },
                    declaredText ? ANT_OPENAI : ANT_LING,
                    declaredText ? api.hash : ling.hash,
                  )
                : {}),
              ...(requestMap
                ? {
                    requestMap: {
                      derivation: 'docs-derived' as const,
                      sourceUrl: ANT_OPENAI,
                      sourceHash: api.hash,
                      path: 'Request Body',
                    },
                  }
                : {}),
              ...(facts.pricing
                ? tagDocsFacts(
                    { pricing: facts.pricing },
                    ANT_PRICE,
                    pricing.hash,
                  )
                : {}),
            },
          }
        },
      ),
    }
  },
  async fetchSpec(_env) {
    const api = await load(ANT_OPENAI)
    return {
      specs: [antSpec(api.html)],
      sources: [{ url: ANT_OPENAI, hash: api.hash }],
      outputStrategy: 'post-200',
    }
  },
  classify: (path) => (path === '/v1/chat/completions' ? 'chat' : null),
}
