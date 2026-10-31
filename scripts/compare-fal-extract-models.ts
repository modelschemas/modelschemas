/**
 * Issue #550: score candidate FAL rate-card extract models on the same
 * Pricing sections, through the production prompt, checks and repair turn
 * (`extractRateCard`). Calls each provider directly with its own key
 * (env or Doppler `dev`); the gateway passes provider rates through, so the
 * cost column matches what Unified Billing would charge (before its 5%).
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
  extractRateCard,
  isStubPricingSection,
  pricingSection,
  pricingSectionHash,
} from '../src/server/ingest/extract-fal-pricing.ts'
import type {
  ChatMessage,
  ExtractChat,
} from '../src/server/ingest/extract-fal-pricing.ts'
import { priceFalNamedSection } from '../src/server/ingest/fal-unit-rate.ts'
import { requestSchemaPropertyNames } from '../src/server/providers/fact-sources.ts'

interface Candidate {
  /** Gateway catalog id. */
  id: string
  /** USD per million tokens, from the gateway catalog. */
  input: number
  output: number
  call: (messages: Array<ChatMessage>) => Promise<{
    content: string
    inputTokens: number
    outputTokens: number
  }>
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

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text) as Record<string, unknown>
}

/** OpenAI-compatible chat completions, the request the gateway is sent. */
function openAiCompat(
  url: string,
  key: string,
  model: string,
  extra: Record<string, unknown> = { temperature: 0 },
): Candidate['call'] {
  return async (messages) => {
    const data = await postJson(
      url,
      { Authorization: `Bearer ${key}` },
      {
        model,
        messages,
        response_format: { type: 'json_object' },
        ...extra,
      },
    )
    const choices = data.choices as Array<{ message: { content: string } }>
    const usage = data.usage as {
      prompt_tokens: number
      completion_tokens: number
      completion_tokens_details?: { reasoning_tokens?: number }
    }
    // xAI reports reasoning outside completion_tokens; both are billed.
    const reasoning = url.includes('x.ai')
      ? (usage.completion_tokens_details?.reasoning_tokens ?? 0)
      : 0
    return {
      content: choices[0]?.message.content ?? '',
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens + reasoning,
    }
  }
}

function anthropic(model: string): Candidate['call'] {
  const key = secret('ANTHROPIC_API_KEY')
  return async (messages) => {
    const system = messages.find((m) => m.role === 'system')?.content
    const data = await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      {
        model,
        max_tokens: 8192,
        temperature: 0,
        system,
        messages: messages.filter((m) => m.role !== 'system'),
      },
    )
    const content = (data.content as Array<{ type: string; text?: string }>)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    const usage = data.usage as { input_tokens: number; output_tokens: number }
    return {
      content,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    }
  }
}

const CANDIDATES: Record<string, () => Candidate> = {
  'anthropic/claude-sonnet-5.5': () => ({
    id: 'anthropic/claude-sonnet-5.5',
    input: 2,
    output: 10,
    call: anthropic('claude-sonnet-5-5'),
  }),
  'anthropic/claude-haiku-5.5': () => ({
    id: 'anthropic/claude-haiku-5.5',
    input: 0.1,
    output: 0.5,
    call: anthropic('claude-haiku-5-5'),
  }),
  'openai/gpt-6-luna': () => ({
    id: 'openai/gpt-6-luna',
    input: 0.1,
    output: 0.5,
    call: openAiCompat(
      'https://api.openai.com/v1/chat/completions',
      secret('OPENAI_API_KEY'),
      'gpt-6-luna',
      // Luna 400s on temperature 0 ("only the default (1)").
      { reasoning_effort: 'low' },
    ),
  }),
  'xai/grok-4.7': () => ({
    id: 'xai/grok-4.7',
    input: 4,
    output: 12,
    call: openAiCompat(
      'https://api.x.ai/v1/chat/completions',
      secret('XAI_API_KEY'),
      'grok-4.7',
    ),
  }),
  'google/gemini-3.8-flash': () => ({
    id: 'google/gemini-3.8-flash',
    input: 0.75,
    output: 3.75,
    call: openAiCompat(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      secret('GEMINI_API_KEY'),
      'gemini-3.8-flash',
    ),
  }),
}

interface Section {
  rawId: string
  text: string
  hash: string
  requestProperties: Set<string>
  truth?: RateCard
  truthStale?: boolean
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
    const chat: ExtractChat = async (messages) => {
      turns++
      try {
        const reply = await candidate.call(messages)
        row.usd +=
          (reply.inputTokens * candidate.input +
            reply.outputTokens * candidate.output) /
          1e6
        return reply.content
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
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
    flag('--models') ?? Object.keys(CANDIDATES).join(',')
  ).split(',')

  const cachePath = flag('--cache')
  const cached = cachePath ? await readCache(cachePath) : null
  const sections: Array<Section> = cached ?? []
  if (!cached)
    for (const truth of FIXTURES) {
      const section = await loadSection(rawIdOf(truth.source.url))
      if (!section) continue
      sections.push({
        ...section,
        truth,
        truthStale: section.hash !== truth.source.hash,
      })
    }
  if (!cached) {
    sections.push(
      ...(await sampleLeftovers(
        leftoverCount,
        new Set(sections.map((s) => s.rawId)),
      )),
    )
    if (cachePath) await writeCache(cachePath, sections)
  }
  console.error(
    `${sections.length} sections (${sections.filter((s) => s.truth).length} with hand cards; stale hash: ${
      sections
        .filter((s) => s.truthStale)
        .map((s) => s.rawId)
        .join(', ') || 'none'
    })`,
  )

  const rows: Array<Row> = []
  for (const id of modelIds) {
    const make = CANDIDATES[id]
    if (!make) throw new Error(`unknown model ${id}`)
    rows.push(await score(make(), sections))
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
