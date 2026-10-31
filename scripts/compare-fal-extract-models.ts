/**
 * Issue #550: score candidate FAL rate-card extract models on the same
 * Pricing sections, through the production prompt, checks and repair turn
 * (`extractRateCard` over `gatewayChat`: TanStack AI with the
 * `@tanstack/ai-cloudflare` adapter, as production runs). Only the gateway hop is swapped: a stand-in binding
 * sends the adapter's request to the provider with its own key (env or
 * Doppler `dev`). The gateway passes provider rates through, so the cost
 * column matches what Unified Billing would charge (before its 5% fee).
 *
 *   bun scripts/compare-fal-extract-models.ts [--leftovers 13] [--models a,b] [--cache file.json]
 *
 * Ground truth: the hand-checked FAL cards in packages/rate-card/src/fixtures.
 * A fixture matches when the extracted card reproduces every one of the
 * fixture's examples within 1%.
 */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'

import { price } from '../packages/rate-card/src/evaluate.ts'
import type { RateCard } from '../packages/rate-card/src/card.ts'
import {
  GPT_IMAGE_2_5_FLARE_EDIT,
  GPT_IMAGE_2_5_FLARE_TEXT_TO_IMAGE,
} from '../packages/rate-card/src/fixtures/gpt-image-2-5-flare-text-to-image.ts'
import { GROK_IMAGINE_VIDEO_REFERENCE_TO_VIDEO } from '../packages/rate-card/src/fixtures/grok-imagine-video-reference-to-video.ts'
import {
  H3_MAX_IMAGE_TO_VIDEO,
  H3_MAX_TEXT_TO_VIDEO,
} from '../packages/rate-card/src/fixtures/h3-max-image-to-video.ts'
import { H3_MAX_REFERENCE_TO_VIDEO } from '../packages/rate-card/src/fixtures/h3-max-reference-to-video.ts'
import { KLING_V3_PRO_IMAGE_TO_VIDEO } from '../packages/rate-card/src/fixtures/kling-v3-pro-image-to-video.ts'
import { NANO_BANANA_2 } from '../packages/rate-card/src/fixtures/nano-banana-2.ts'
import { SEEDANCE_FAL_RATE_CARDS } from '../packages/rate-card/src/fixtures/seedance-fal.ts'
import {
  FAL_PRICING_EXTRACT_OPTIONS,
  extractRateCard,
  gatewayChat,
  isStubPricingSection,
  pricingSection,
  pricingSectionHash,
} from '../src/server/ingest/extract-fal-pricing.ts'
import type { ExtractChat } from '../src/server/ingest/extract-fal-pricing.ts'
import { priceFalNamedSection } from '../src/server/ingest/fal-unit-rate.ts'
import { requestSchemaPropertyNames } from '../src/server/providers/fact-sources.ts'

interface Candidate {
  /** Gateway catalog id. */
  id: string
  /** USD per million tokens, from the gateway catalog. */
  input: number
  output: number
  modelOptions: Record<string, unknown>
  /** Where the stand-in binding sends the call: an OpenAI-compatible endpoint. */
  url: string
  keyName: string
  providerModel: string
}

function secret(name: string): string {
  const fromEnv = process.env[name]
  if (fromEnv) return fromEnv
  return execFileSync(
    'doppler',
    ['secrets', 'get', name, '--plain', '-p', 'modelschemas', '-c', 'dev'],
    { encoding: 'utf8' },
  ).trim()
}

const JSON_MODE = { response_format: { type: 'json_object' } }

const CANDIDATES: Array<Candidate> = [
  {
    id: 'anthropic/claude-sonnet-5.5',
    input: 2,
    output: 10,
    // Claude 5.5 refuses temperature and json_object here; the prompt
    // asks for JSON only.
    modelOptions: {},
    url: 'https://api.anthropic.com/v1/chat/completions',
    keyName: 'ANTHROPIC_API_KEY',
    providerModel: 'claude-sonnet-5-5',
  },
  {
    id: 'anthropic/claude-haiku-5.5',
    input: 0.1,
    output: 0.5,
    // Claude 5.5 refuses temperature and json_object here; the prompt
    // asks for JSON only.
    modelOptions: {},
    url: 'https://api.anthropic.com/v1/chat/completions',
    keyName: 'ANTHROPIC_API_KEY',
    providerModel: 'claude-haiku-5-5',
  },
  {
    id: 'openai/gpt-6-luna',
    input: 0.1,
    output: 0.5,
    // Luna 400s on temperature 0 ("only the default (1)").
    modelOptions: { ...JSON_MODE, reasoning_effort: 'low' },
    url: 'https://api.openai.com/v1/chat/completions',
    keyName: 'OPENAI_API_KEY',
    providerModel: 'gpt-6-luna',
  },
  {
    id: 'xai/grok-4.7',
    input: 4,
    output: 12,
    modelOptions: { ...FAL_PRICING_EXTRACT_OPTIONS },
    url: 'https://api.x.ai/v1/chat/completions',
    keyName: 'XAI_API_KEY',
    providerModel: 'grok-4.7',
  },
  {
    id: 'google/gemini-3.8-flash',
    input: 0.75,
    output: 3.75,
    modelOptions: { ...FAL_PRICING_EXTRACT_OPTIONS },
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keyName: 'GEMINI_API_KEY',
    providerModel: 'gemini-3.8-flash',
  },
]

interface ProviderUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens?: number
}

/** The usage object of a chat completion, streamed (last `usage` chunk) or not. */
async function readUsage(response: Response): Promise<ProviderUsage> {
  const text = await response.text()
  if (!response.headers.get('content-type')?.includes('event-stream'))
    return (JSON.parse(text) as { usage: ProviderUsage }).usage
  let usage: ProviderUsage = { prompt_tokens: 0, completion_tokens: 0 }
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: {')) continue
    const chunk = JSON.parse(line.slice(6)) as { usage?: ProviderUsage | null }
    if (chunk.usage) usage = chunk.usage
  }
  return usage
}

/**
 * Stands in for `env.AI` with a gateway: the adapter's `run(model, inputs,
 * { gateway, returnRawResponse })` goes to the provider instead, with the
 * same inputs, and the raw response comes back as the gateway's would.
 */
function standInBinding(
  candidate: Candidate,
  onUsage: (usage: ProviderUsage) => void,
): Ai {
  const key = secret(candidate.keyName)
  const run = async (_model: string, inputs: Record<string, unknown>) => {
    const response = await fetch(candidate.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        ...inputs,
        model: candidate.providerModel,
        ...(inputs.stream ? { stream_options: { include_usage: true } } : {}),
      }),
    })
    // The adapter drops a stream's trailing usage chunk, so read it here.
    if (response.ok) void readUsage(response.clone()).then(onUsage)
    return response
  }
  return { run, gateway: () => ({}) } as unknown as Ai
}

interface Section {
  rawId: string
  text: string
  hash: string
  requestProperties: Set<string>
  truth?: RateCard
}

const FIXTURES: Array<RateCard> = [
  GPT_IMAGE_2_5_FLARE_TEXT_TO_IMAGE,
  GPT_IMAGE_2_5_FLARE_EDIT,
  GROK_IMAGINE_VIDEO_REFERENCE_TO_VIDEO,
  H3_MAX_IMAGE_TO_VIDEO,
  H3_MAX_TEXT_TO_VIDEO,
  H3_MAX_REFERENCE_TO_VIDEO,
  KLING_V3_PRO_IMAGE_TO_VIDEO,
  NANO_BANANA_2,
  ...Object.values(SEEDANCE_FAL_RATE_CARDS),
]

function rawIdOf(llmsUrl: string): string {
  return llmsUrl
    .replace('https://fal.ai/models/', '')
    .replace(/\/llms\.txt$/, '')
}

const FAL_MODELS_URL = 'https://api.fal.ai/v1/models'

async function falModels(params: URLSearchParams): Promise<Array<FalModel>> {
  const key = secret('FAL_KEY')
  const models: Array<FalModel> = []
  let cursor: string | null = null
  do {
    if (cursor) params.set('cursor', cursor)
    const response = await fetch(`${FAL_MODELS_URL}?${params.toString()}`, {
      headers: { Authorization: `Key ${key}` },
    })
    if (!response.ok) throw new Error(`fal models ${response.status}`)
    const page = (await response.json()) as {
      models: Array<FalModel>
      has_more: boolean
      next_cursor: string | null
    }
    models.push(...page.models)
    cursor = page.has_more ? page.next_cursor : null
  } while (cursor)
  return models
}

interface FalModel {
  endpoint_id: string
  openapi?: {
    paths?: Record<string, { post?: { requestBody?: unknown } }>
    components?: { schemas?: Record<string, unknown> }
  }
}

/** Top-level input fields of the endpoint's POST body, as the bound schema has them. */
async function requestPropertiesOf(rawId: string): Promise<Set<string>> {
  const params = new URLSearchParams({
    endpoint_id: rawId,
    expand: 'openapi-3.0',
  })
  const [model] = await falModels(params)
  const spec = model?.openapi
  const post = Object.values(spec?.paths ?? {}).find((op) => op.post)?.post
  let schema: unknown = (
    post?.requestBody as
      | { content?: Record<string, { schema?: unknown }> }
      | undefined
  )?.content?.['application/json']?.schema
  const ref = (schema as { $ref?: string } | undefined)?.$ref
  if (ref) schema = spec?.components?.schemas?.[ref.split('/').pop() ?? '']
  return requestSchemaPropertyNames(schema)
}

async function loadSection(rawId: string): Promise<Section | null> {
  const response = await fetch(`https://fal.ai/models/${rawId}/llms.txt`)
  if (!response.ok) return null
  const text = pricingSection(await response.text())
  if (text.length === 0) return null
  return {
    rawId,
    text,
    hash: await pricingSectionHash(text),
    requestProperties: await requestPropertiesOf(rawId),
  }
}

/** Priced sections the unit-rate parser cannot compile — what reaches the model. */
async function sampleLeftovers(
  count: number,
  skip: ReadonlySet<string>,
): Promise<Array<Section>> {
  const rawIds = (await falModels(new URLSearchParams({ status: 'active' })))
    .map((m) => m.endpoint_id)
    .filter((id) => !skip.has(id))
    .sort()
  // Deterministic spread over the roster, not the first N alphabetically.
  const step = 7
  const picked: Array<Section> = []
  const hashes = new Set<string>()
  for (let offset = 0; offset < step && picked.length < count; offset++) {
    for (
      let i = offset;
      i < rawIds.length && picked.length < count;
      i += step
    ) {
      const section = await loadSection(rawIds[i] as string)
      if (!section || isStubPricingSection(section.text)) continue
      if (hashes.has(section.hash)) continue
      const compiled = priceFalNamedSection(
        section.text,
        section.requestProperties,
        { url: 'x', hash: section.hash, extractedAt: new Date().toISOString() },
      )
      if (compiled) continue
      hashes.add(section.hash)
      picked.push(section)
    }
  }
  return picked
}

/** null = the card reproduces every hand-card example within 1%; else the first miss. */
function truthMiss(card: RateCard, truth: RateCard): string | null {
  for (const example of truth.examples) {
    try {
      // Same flat-bag read as verifyExamples.
      const amount = price(card, example.params, example.params)
      if (Math.abs(amount - example.usd) > example.usd * 0.01)
        return `${JSON.stringify(example.params)} → ${amount}, hand card ${example.usd}`
    } catch (error) {
      return `${JSON.stringify(example.params)} → ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return null
}

interface Row {
  model: string
  sections: number
  passed: number
  repaired: number
  truthTotal: number
  truthMatched: number
  usd: number
  ms: Array<number>
  failures: Array<string>
}

async function score(candidate: Candidate, sections: Array<Section>) {
  const row: Row = {
    model: candidate.id,
    sections: sections.length,
    passed: 0,
    repaired: 0,
    truthTotal: 0,
    truthMatched: 0,
    usd: 0,
    ms: [],
    failures: [],
  }
  for (const section of sections) {
    let turns = 0
    const binding = standInBinding(candidate, (usage) => {
      // Reasoning billed outside completion tokens (xAI) shows in the total.
      const output = Math.max(
        usage.completion_tokens,
        (usage.total_tokens ?? 0) - usage.prompt_tokens,
      )
      row.usd +=
        (usage.prompt_tokens * candidate.input + output * candidate.output) /
        1e6
    })
    const gateway = gatewayChat(binding, 'stand-in', {
      model: candidate.id,
      modelOptions: candidate.modelOptions,
    })
    const chat: ExtractChat = (messages) => {
      turns++
      return gateway(messages)
    }
    const started = performance.now()
    const result = await extractRateCard({
      pricingText: section.text,
      requestProperties: section.requestProperties,
      sourceUrl: `https://fal.ai/models/${section.rawId}/llms.txt`,
      sourceHash: section.hash,
      now: Math.floor(Date.now() / 1000),
      chat,
    })
    row.ms.push(performance.now() - started)
    const ok = result !== 'unverified' && !('error' in result)
    if (ok) row.passed++
    else
      row.failures.push(
        `${section.rawId}: ${result === 'unverified' ? 'unverified' : result.error.slice(0, 160)}`,
      )
    if (ok && turns > 1) row.repaired++
    if (section.truth) {
      row.truthTotal++
      const miss = ok ? truthMiss(result, section.truth) : 'no card'
      if (miss === null) row.truthMatched++
      else if (ok)
        row.failures.push(
          `${section.rawId}: ≠ hand card: ${miss.slice(0, 200)}`,
        )
    }
    process.stderr.write('.')
  }
  process.stderr.write(` ${candidate.id}\n`)
  return row
}

async function readCache(path: string): Promise<Array<Section> | null> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return null
  const rows = JSON.parse(text) as Array<
    Omit<Section, 'requestProperties'> & { requestProperties: Array<string> }
  >
  return rows.map((row) => ({
    ...row,
    requestProperties: new Set(row.requestProperties),
  }))
}

async function writeCache(
  path: string,
  sections: Array<Section>,
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify(
      sections.map((section) => ({
        ...section,
        requestProperties: [...section.requestProperties],
      })),
      null,
      2,
    ),
  )
}

function median(values: Array<number>): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const leftoverCount = Number(flag('--leftovers') ?? 13)
  const modelIds = (
    flag('--models') ?? CANDIDATES.map((c) => c.id).join(',')
  ).split(',')

  const cachePath = flag('--cache')
  const cached = cachePath ? await readCache(cachePath) : null
  const sections: Array<Section> = cached ?? []
  if (!cached) {
    for (const truth of FIXTURES) {
      const section = await loadSection(rawIdOf(truth.source.url))
      if (section) sections.push({ ...section, truth })
    }
    sections.push(
      ...(await sampleLeftovers(
        leftoverCount,
        new Set(sections.map((s) => s.rawId)),
      )),
    )
    if (cachePath) await writeCache(cachePath, sections)
  }
  console.error(
    `${sections.length} sections, ${sections.filter((s) => s.truth).length} with hand cards`,
  )

  const rows: Array<Row> = []
  for (const id of modelIds) {
    const candidate = CANDIDATES.find((c) => c.id === id)
    if (!candidate) throw new Error(`unknown model ${id}`)
    rows.push(await score(candidate, sections))
  }

  console.log(
    '| Model | Pass | Hand-card match | Repair turns | Cost / page | Median latency |',
  )
  console.log('|---|---|---|---|---|---|')
  for (const row of rows) {
    console.log(
      `| ${row.model} | ${row.passed}/${row.sections} | ${row.truthMatched}/${row.truthTotal} | ${row.repaired}/${row.passed} | $${(row.usd / row.sections).toFixed(4)} | ${(median(row.ms) / 1000).toFixed(1)}s |`,
    )
  }
  for (const row of rows) {
    if (row.failures.length === 0) continue
    console.log(`\n${row.model}:`)
    for (const failure of row.failures) console.log(`- ${failure}`)
  }
}

await main()
