/** Both Kimi Coding regions are explicitly documented in the same native page. */
import { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ProviderConfig } from './types.ts'
import { KIMI_CODE_MODELS_URL, parseKimiCodeModels } from './kimi-code-docs.ts'

export function kimiCodeProvider(
  id: string,
  displayName: string,
): ProviderConfig {
  return {
    id,
    displayName,
    specSourceUrl: KIMI_CODE_MODELS_URL,
    modelsEndpoint: KIMI_CODE_MODELS_URL,
    defaultDerivation: 'docs-derived',
    bindSyncedRoutesOnly: true,
    async listModels(_env, kv) {
      const doc = await cachedDocs(kv, KIMI_CODE_MODELS_URL, async () => {
        const html = await fetchText(KIMI_CODE_MODELS_URL)
        return { html, hash: await sha256Text(html) }
      })
      return {
        models: parseKimiCodeModels(doc.html, {
          derivation: 'docs-derived',
          sourceUrl: KIMI_CODE_MODELS_URL,
          sourceHash: doc.hash,
        }).map((model) => ({
          ...model,
          absent: { pricing: 'cleared' as const },
        })),
      }
    },
    async fetchSpec() {
      const html = await fetchText(KIMI_CODE_MODELS_URL)
      const hash = await sha256Text(html)
      parseKimiCodeModels(html, {
        derivation: 'docs-derived',
        sourceUrl: KIMI_CODE_MODELS_URL,
        sourceHash: hash,
      })
      return {
        specs: [],
        sources: [{ url: KIMI_CODE_MODELS_URL, hash }],
        outputStrategy: 'post-200' as const,
        skipped: `${id}: native Coding docs publish model facts, but no sourced request/response schema — skipped`,
      }
    },
    classify: () => null,
  }
}
