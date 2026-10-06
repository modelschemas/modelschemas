/**
 * Cohere token prices from cohere.com/pricing (issue #111). The legacy FAQ
 * prices dated Command R rows (`Command R+ 08-2024 pricing is $2.50/1M …`).
 * Undated "Command" and "Command-light" do not name an API id, so they get
 * no card. Aya Expanse states one rate for 8B and 32B; only backtick ids on
 * the Aya model page receive it.
 *
 * The generative tab is not in the rendered HTML, only in the page's data
 * payload, as cards named by product ("Command R7B", per "1M tokens"). A
 * card prices the one `Live` id the models overview dates under that name
 * (`command-r7b-12-2024`); none or several means no card. The "Free" cards
 * (Command A+, North Mini Code) state no token price.
 */
import { compileTokenCard } from '@modelschemas/rate-card'

import {
  COHERE_MODELS_DOC_URL,
  parseCohereModelTable,
} from './cohere-model-docs.ts'
import { tagDocsFacts } from './fact-sources.ts'
import { assertParsed, cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const COHERE_PRICING_URL = 'https://cohere.com/pricing'
export const COHERE_AYA_URL = 'https://docs.cohere.com/docs/aya-expanse.md'

const DATED_COMMAND =
  /Command R(\+)? (\d{2}-\d{4}) pricing is \$([\d.]+)\/1M tokens for input and \$([\d.]+)\/1M tokens for output/g

const AYA_RATE =
  /Aya Expanse models \(8B and 32B\) on the API are charged at \$([\d.]+)\/1M tokens for input and \$([\d.]+)\/1M tokens for output/

const CARD = /"modelName":"([A-Za-z0-9 ]+)","per":"1M tokens"/g

const CARD_PRICE =
  /"pricings":\[\{"_key":"[^"]*","_type":"pricing","inputLabel":"Input","inputPrice":(\d+(?:\.\d+)?),"outputLabel":"Output","outputPrice":(\d+(?:\.\d+)?)\}\]/

function perMillion(amount: string): number {
  return Number((Number(amount) / 1e6).toPrecision(12))
}

/** Product name, input and output dollars per 1M, from the data payload. */
function pricingCards(pricingHtml: string): Array<[string, string, string]> {
  const payload = pricingHtml.replace(/\\"/g, '"')
  const cards: Array<[string, string, string]> = []
  for (const match of payload.matchAll(CARD)) {
    const start = match.index + match[0].length
    const next = payload.indexOf('"modelName":"', start)
    const price = CARD_PRICE.exec(
      payload.slice(start, next < 0 ? undefined : next),
    )
    if (match[1] && price?.[1] && price[2]) {
      cards.push([match[1], price[1], price[2]])
    }
  }
  return cards
}

/**
 * API id → per-token rates. `ayaMarkdown` is the Aya Expanse model page,
 * `liveIds` the ids the models overview marks `Live`.
 */
export function parseCoherePricing(
  pricingHtml: string,
  ayaMarkdown: string,
  liveIds: Array<string> = [],
): Map<string, Record<string, number>> {
  const text = pricingHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
  const out = new Map<string, Record<string, number>>()
  for (const match of text.matchAll(DATED_COMMAND)) {
    const plus = match[1] === '+'
    const date = match[2]
    const input = match[3]
    const output = match[4]
    if (!date || !input || !output) continue
    const id = plus ? `command-r-plus-${date}` : `command-r-${date}`
    if (out.has(id)) continue
    out.set(id, {
      input_tokens: perMillion(input),
      output_tokens: perMillion(output),
    })
  }
  const aya = text.match(AYA_RATE)
  if (aya?.[1] && aya[2]) {
    const rates = {
      input_tokens: perMillion(aya[1]),
      output_tokens: perMillion(aya[2]),
    }
    const ids = [
      ...ayaMarkdown.matchAll(/`(c4ai-aya-expanse-(?:8|32)b)`/g),
    ].map((match) => match[1] ?? '')
    for (const id of ids) {
      if (id && !out.has(id)) out.set(id, rates)
    }
  }
  for (const [name, input, output] of pricingCards(pricingHtml)) {
    const dated = new RegExp(
      `^${name.toLowerCase().replace(/ /g, '-')}-\\d{2}-\\d{4}$`,
    )
    const ids = liveIds.filter((id) => dated.test(id))
    const id = ids.length === 1 ? ids[0] : undefined
    if (!id || out.has(id) || Number(input) <= 0 || Number(output) <= 0) {
      continue
    }
    out.set(id, {
      input_tokens: perMillion(input),
      output_tokens: perMillion(output),
    })
  }
  return out
}

type PricedFacts = Pick<ModelInfo, 'pricing' | 'factSources'>

/** Card lookup by listed model id. Ids the pages do not price get nothing. */
export async function cohereModelPricing(
  kv?: KVNamespace,
): Promise<(rawId: string) => PricedFacts> {
  const doc = await cachedDocs(kv, COHERE_PRICING_URL, async () => {
    const page = (url: string) =>
      fetchText(url, { signal: AbortSignal.timeout(30_000) })
    const [pricingHtml, ayaMarkdown, modelsMarkdown] = await Promise.all([
      page(COHERE_PRICING_URL),
      page(COHERE_AYA_URL),
      page(COHERE_MODELS_DOC_URL),
    ])
    const liveIds = [...parseCohereModelTable(modelsMarkdown)]
      .filter(([, row]) => row.live)
      .map(([id]) => id)
    const parsed = parseCoherePricing(pricingHtml, ayaMarkdown, liveIds)
    assertParsed(parsed, 'cohere pricing page')
    const ayaNamed = /Aya Expanse models \(8B and 32B\)/.test(
      pricingHtml.replace(/<[^>]+>/g, ' '),
    )
    const ayaIds = [...parsed.keys()].filter((id) => id.startsWith('c4ai-aya-'))
    if (ayaNamed && ayaIds.length === 0) {
      throw new Error('cohere pricing page: Aya Expanse rate matched no API id')
    }
    return {
      rates: Object.fromEntries(parsed),
      hash: await sha256Text(
        `${pricingHtml}\n${ayaMarkdown}\n${modelsMarkdown}`,
      ),
      extractedAt: new Date().toISOString(),
    }
  })
  return (rawId) => {
    const rates = doc.rates[rawId]
    if (!rates) return {}
    const pricing = compileTokenCard(rates, [], {
      url: COHERE_PRICING_URL,
      hash: doc.hash,
      extractedAt: doc.extractedAt,
    })
    if (!pricing) return {}
    return {
      pricing,
      factSources: tagDocsFacts({ pricing }, COHERE_PRICING_URL, doc.hash),
    }
  }
}
