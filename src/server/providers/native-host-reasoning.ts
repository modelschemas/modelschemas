import { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo, FactSource } from './types.ts'

export const HF_CHAT_GUIDE =
  'https://huggingface.co/docs/inference-providers/tasks/chat-completion'
function reasoningStatement(text: string): boolean {
  // A negation elsewhere in a description can qualify a later positive
  // phrase or describe a different model. Ambiguous prose remains unknown.
  if (
    /\b(?:not|no|without|never|cannot|doesn't|don't|lack|lacks|lacking|unsupported)\b/i.test(
      text,
    )
  )
    return false
  const clauses = text.split(/[.!?;]/)
  return clauses.some(
    (clause) =>
      !/\b(?:not|no|without|never|cannot|doesn't)\b/i.test(clause) &&
      /(?:reasoning (?:capabilities|based|vision language model|trace)|reasoning, and conversational capabilities|controllable thinking effort|shorter reasoning traces)/i.test(
        clause,
      ),
  )
}
export function parseHfHostedReasoning(html: string): Array<string> {
  const section = html.match(
    /id="recommended-models"[\s\S]*?<\/h3>([\s\S]*?)(?:<h2|$)/i,
  )?.[1]
  if (!section)
    throw new Error('huggingface: native recommendation section missing')
  const ids: Array<string> = []
  for (const row of section.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const text = row[1]!.replace(/<[^>]*>/g, '')
    if (!reasoningStatement(text)) continue
    const link = row[1]!.match(/href="https:\/\/huggingface\.co\/([^"?#]+)"/)
    if (!link || !link[1]!.includes('/'))
      throw new Error(
        'huggingface: reasoning recommendation has no exact native model link',
      )
    ids.push(link[1]!)
  }
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error('huggingface: native reasoning recommendations unreadable')
  return ids
}
export function nativeReasoningCapability(
  model: ModelInfo,
  source: FactSource,
): ModelInfo {
  const caps = model.capabilities
  if (
    model.unsupportedCapabilities?.includes('reasoning') ||
    (caps &&
      !Array.isArray(caps) &&
      typeof caps === 'object' &&
      'reasoning' in caps &&
      caps.reasoning === false)
  )
    throw new Error(
      'native host reasoning evidence contradicts explicit negative for ' +
        model.rawId,
    )
  if (caps != null && !Array.isArray(caps) && typeof caps !== 'object')
    throw new Error('native host reasoning: unreadable capabilities')
  if (
    Array.isArray(caps) &&
    !(caps as Array<unknown>).every((value) => typeof value === 'string')
  )
    throw new Error('native host reasoning: unreadable capability list')
  const capabilities = Array.isArray(caps)
    ? [...new Set([...(caps as Array<string>), 'reasoning'])]
    : caps && typeof caps === 'object'
      ? { ...caps, reasoning: true }
      : ['reasoning']
  return {
    ...model,
    capabilities,
    factSources: {
      ...model.factSources,
      capabilities: { ...model.factSources?.capabilities, reasoning: source },
    },
  }
}
export function parseFireworksNativeReasoning(
  body: unknown,
  rawId: string,
): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('fireworks: unreadable native model metadata')
  const data = body as Record<string, unknown>
  if (data.name !== rawId || typeof data.description !== 'string')
    throw new Error(
      'fireworks: native model metadata identity/description mismatch for ' +
        rawId,
    )
  return reasoningStatement(data.description)
}
export async function fireworksHostedReasoning(
  model: ModelInfo,
  apiKey: string,
  kv?: KVNamespace,
): Promise<ModelInfo> {
  if (
    model.activity !== 'chat' ||
    model.reasoning ||
    !/^accounts\/[^/]+\/models\/[^/]+$/.test(model.rawId)
  )
    return model
  const url = 'https://api.fireworks.ai/v1/' + model.rawId
  const doc = await cachedDocs(kv, url, async () => {
    const text = await fetchText(url, {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: AbortSignal.timeout(30_000),
    })
    return {
      supported: parseFireworksNativeReasoning(JSON.parse(text), model.rawId),
      hash: await sha256Text(text),
    }
  })
  return doc.supported
    ? nativeReasoningCapability(model, {
        derivation: 'listing',
        sourceUrl: url,
        sourceHash: doc.hash,
        path: 'description',
      })
    : model
}
