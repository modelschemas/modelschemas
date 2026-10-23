/**
 * Command model pages (issue #447). The models overview links each Command
 * model to its own page. The showcase's token rates and knowledge cutoff
 * are stored. "Free until rate limits are reached" is an evaluation quota
 * (20 req/min, 1,000 calls/month; production is sales or Model Vault), so
 * it writes no card. The context-window cell is not copied: `GET /v1/models`
 * `context_length` and this cell disagree (Command A+ is 436000 on the
 * listing and 128,000 on the page), and neither source says which wins.
 *
 * A page that does not fetch throws. A token-price sentence that no longer
 * matches writes no card.
 */
import { compileTokenCard } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { COHERE_MODELS_DOC_URL } from './cohere-model-docs.ts'
import { tagDocsFacts } from './fact-sources.ts'
import { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

const FAMILY =
  /The Command family of models includes((?:\s*(?:and\s+)?\[[^\]]+\]\([^)]+\),?)+)/

const FREE =
  /For both trial keys and production keys, .+ is free until rate limits are reached\./

const TOKEN_PRICE =
  /Input \$ (\d+(?:\.\d+)?) \/ 1M tokens Output \$ (\d+(?:\.\d+)?) \/ 1M tokens/

const MONTHS: Record<string, string> = {
  January: '01',
  February: '02',
  March: '03',
  April: '04',
  May: '05',
  June: '06',
  July: '07',
  August: '08',
  September: '09',
  October: '10',
  November: '11',
  December: '12',
}

const CUTOFF = new RegExp(
  `Knowledge Cutoff: (${Object.keys(MONTHS).join('|')}) (\\d{1,2}), (\\d{4})`,
)

export interface CoherePageFacts {
  pricing?: RateCard
  knowledgeCutoff?: string
}

/**
 * Relative slugs in the overview's Command-family sentence, as page URLs.
 * A page that no longer has that sentence throws: returning no URLs would
 * clear stored cutoffs and the Command A card on the next poll.
 */
export function commandFamilyPageUrls(markdown: string): Array<string> {
  const sentence = FAMILY.exec(markdown)?.[1]
  if (!sentence) {
    throw new Error('cohere models page: Command family links are missing')
  }
  const urls: Array<string> = []
  for (const link of sentence.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const href = link[1] ?? ''
    if (!/^[a-z0-9-]+$/.test(href)) continue
    const url = `https://docs.cohere.com/docs/${href}`
    if (!urls.includes(url)) urls.push(url)
  }
  if (urls.length === 0) {
    throw new Error('cohere models page: Command family links are unreadable')
  }
  return urls
}

function showcase(html: string): string | null {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
  const start = text.indexOf(' Pricing ')
  const end = text.indexOf(' Try in Playground ')
  if (start < 0 || end < start) return null
  return text.slice(start, end)
}

function perMillion(amount: string): number {
  return Number((Number(amount) / 1e6).toPrecision(12))
}

/**
 * Facts the showcase states for its Model ID. No showcase, no model id,
 * or a price sentence that no longer matches: nothing, not a guess.
 * The "free until rate limits" sentence is a quota, so it stores no card.
 * That sentence beside a token price is a conflict, so neither is stored.
 */
export function parseCohereModelPage(
  html: string,
  source: RateCard['source'],
): { id: string; facts: CoherePageFacts } | null {
  const box = showcase(html)
  if (!box) return null
  const id = /Model ID ([a-z0-9][a-z0-9.-]*)/.exec(box)?.[1]
  if (!id) return null
  const facts: CoherePageFacts = {}
  const free = FREE.test(box)
  const token = TOKEN_PRICE.exec(box)
  if (!free && token?.[1] && token[2]) {
    const card = compileTokenCard(
      {
        input_tokens: perMillion(token[1]),
        output_tokens: perMillion(token[2]),
      },
      [],
      source,
    )
    if (card) facts.pricing = card
  }
  const cutoff = CUTOFF.exec(box)
  const month = cutoff?.[1] ? MONTHS[cutoff[1]] : undefined
  const day = cutoff?.[2] ? Number(cutoff[2]) : NaN
  const year = cutoff?.[3]
  if (month && year && day >= 1 && day <= 31) {
    facts.knowledgeCutoff = `${year}-${month}-${String(day).padStart(2, '0')}`
  }
  return { id, facts }
}

type PagePatch = Pick<ModelInfo, 'pricing' | 'knowledgeCutoff' | 'factSources'>

/** Lookup by the model id the page names. An id with no page gets nothing. */
export async function cohereCommandPageFacts(
  kv?: KVNamespace,
): Promise<(rawId: string) => PagePatch> {
  const index = await cachedDocs(
    kv,
    `${COHERE_MODELS_DOC_URL}#command-family-links`,
    async () => {
      const markdown = await fetchText(COHERE_MODELS_DOC_URL, {
        signal: AbortSignal.timeout(30_000),
      })
      return { urls: commandFamilyPageUrls(markdown) }
    },
  )
  const pages = await Promise.all(
    index.urls.map((url) =>
      cachedDocs(kv, url, async () => {
        const html = await fetchText(url, {
          signal: AbortSignal.timeout(30_000),
        })
        const hash = await sha256Text(html)
        const parsed = parseCohereModelPage(html, {
          url,
          hash,
          extractedAt: new Date().toISOString(),
        })
        return {
          id: parsed?.id ?? null,
          facts: parsed?.facts ?? {},
          hash,
        }
      }),
    ),
  )
  const byId = new Map<
    string,
    { facts: CoherePageFacts; url: string; hash: string }
  >()
  for (const [indexUrl, page] of index.urls.map(
    (url, i) => [url, pages[i]] as const,
  )) {
    if (!page?.id) continue
    // Two links that name one id (the undated Command slug redirects): keep
    // the first. A later page does not overwrite a card already read.
    if (byId.has(page.id)) continue
    byId.set(page.id, { facts: page.facts, url: indexUrl, hash: page.hash })
  }
  return (rawId) => {
    const page = byId.get(rawId)
    if (!page) return {}
    const facts = page.facts
    if (!facts.pricing && !facts.knowledgeCutoff) return {}
    return {
      ...facts,
      factSources: tagDocsFacts(facts, page.url, page.hash),
    }
  }
}
