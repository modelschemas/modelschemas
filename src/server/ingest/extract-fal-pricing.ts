/**
 * Nightly FAL rate-card extract (issue #68): page candidate catalog rows,
 * fetch each endpoint's llms.txt, hash-skip the Pricing section, and ask
 * one model to write a RateCard. Own cron / admin route — not the 15-min
 * poll and not FAL's spec-sync shard.
 */
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { z } from 'zod'

import { rateCardSchema, verifyExamples } from '@modelschemas/rate-card'
import type { RateCard } from '@modelschemas/rate-card'

import { cacheMeta, changes, models, schemaVersions } from '#/db/schema.ts'
import { errorMessage } from '#/server/errors.ts'
import { falLlmsTxtUrl } from '#/server/providers/fal.ts'
import { markdownSection } from '#/server/providers/model-facts.ts'
import { requestSchemaPropertyNames } from '#/server/providers/fact-sources.ts'
import type { ModelFactSources } from '#/server/providers/types.ts'
import { sha256Text } from '#/server/providers/types.ts'
import { stableStringify } from '#/server/kv.ts'
import { parseStoredRateCard, storeListedPricing } from '#/server/rate-card.ts'
import type { RateCardRefuse } from '#/server/rate-card.ts'
import type { SyncDeps } from './sync.ts'

/** Own invocation, after the 05:00–05:30 spec-sync shards. */
export const FAL_PRICING_EXTRACT_CRON = '0 6 * * *'

export const FAL_PRICING_FETCH_CAP = 200
export const FAL_PRICING_EXTRACT_CAP = 20
/** Consecutive 408/429/5xx/network failures before the run stops walking. */
export const FAL_PRICING_FETCH_FAIL_ABORT = 8

export const FAL_PRICING_EXTRACT_CURSOR_KEY = 'fal-pricing-extract-cursor'

export function falPricingExtractCursorKey(providerId = 'fal'): string {
  return `${FAL_PRICING_EXTRACT_CURSOR_KEY}:${providerId}`
}

/** Single extract model — fail-closed; never a second guess. */
export const FAL_PRICING_EXTRACT_MODEL = 'grok-4-fast'

const XAI_CHAT_URL = 'https://api.x.ai/v1/chat/completions'

const POSITIVE_USD = /\$\s*(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)/

const extractedBodySchema = rateCardSchema.omit({ source: true }).extend({
  expiresAt: z.iso.datetime().optional(),
})

const extractedResponseSchema = z.union([
  z.object({ unverified: z.literal(true) }),
  extractedBodySchema,
])

export type FalPricingExtractRefuse = RateCardRefuse | 'unverified' | 'stub'

export interface FalPricingExtractOutcome {
  providerId: string
  candidates: number
  fetched: number
  extracted: number
  written: number
  hashSkipped: number
  refused: number
  unverified: number
  fetchFailed: number
  cursor: string | null
  skipped?: string
  error?: string
}

export type ExtractedCard = RateCard | 'unverified' | null

export interface ExtractCardArgs {
  pricingText: string
  requestProperties: ReadonlySet<string>
  sourceUrl: string
  sourceHash: string
  now: number
}

/** string body, `null` = 404, `{ status }` for HTTP/network (`0` = network). */
export type FalLlmsFetchResult = string | null | { status: number }

export interface FalPricingExtractDeps extends SyncDeps {
  fetchText?: (url: string) => Promise<FalLlmsFetchResult>
  extractCard?: (args: ExtractCardArgs) => Promise<ExtractedCard>
  fetchCap?: number
  extractCap?: number
  providerId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function pricingSection(llmsTxt: string): string {
  return markdownSection(llmsTxt, 'Pricing').trim()
}

/** No positive dollar amount — empty, boilerplate, or zeros. */
export function isStubPricingSection(section: string): boolean {
  return section.length === 0 || !POSITIVE_USD.test(section)
}

export async function pricingSectionHash(section: string): Promise<string> {
  return sha256Text(section)
}

/**
 * Index to resume from after `cursor` (the last processed rawId). Wraps
 * when the cursor is the tail or no longer in the roster.
 */
export function resumeIndex(
  rawIds: ReadonlyArray<string>,
  cursor: string | null,
): number {
  if (rawIds.length === 0 || cursor === null) return 0
  const exact = rawIds.indexOf(cursor)
  if (exact >= 0) return (exact + 1) % rawIds.length
  const next = rawIds.findIndex((id) => id > cursor)
  return next < 0 ? 0 : next
}

/**
 * Unchanged Pricing hash skips extract unless a promo `expiresAt` is
 * already in the past.
 */
export function shouldSkipExtract(args: {
  storedHash: string | null
  sectionHash: string
  expiresAt: string | undefined
  now: number
}): boolean {
  if (args.storedHash !== args.sectionHash) return false
  if (args.expiresAt === undefined) return true
  return Date.parse(args.expiresAt) > args.now * 1000
}

function factSourcesOf(value: unknown): ModelFactSources | null {
  if (!isRecord(value)) return null
  return value
}

function storedPricingHash(
  card: RateCard | null,
  sources: ModelFactSources | null,
): string | null {
  return sources?.pricing?.sourceHash ?? card?.source.hash ?? null
}

export function isRetryableLlmsStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500
}

function llmsFetchOutcome(
  result: FalLlmsFetchResult,
): { text: string } | { status: number } {
  if (typeof result === 'string') return { text: result }
  if (result === null) return { status: 404 }
  return { status: result.status }
}

async function fetchLlmsTxt(url: string): Promise<FalLlmsFetchResult> {
  try {
    const response = await fetch(url)
    if (!response.ok) return { status: response.status }
    return await response.text()
  } catch {
    return { status: 0 }
  }
}

function logFetchFailure(
  providerId: string,
  rawId: string,
  status: number,
): void {
  console.error(
    JSON.stringify({
      job: 'fal-pricing-extract',
      providerId,
      rawId,
      error: 'llms_txt_fetch_failed',
      status,
    }),
  )
}

function chatContent(data: unknown): string | null {
  if (!isRecord(data)) return null
  const choices = data.choices
  if (!Array.isArray(choices)) return null
  const first: unknown = choices[0]
  if (!isRecord(first)) return null
  const message = first.message
  if (!isRecord(message) || typeof message.content !== 'string') return null
  return message.content
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const body = fenced?.[1] ?? trimmed
  return JSON.parse(body) as unknown
}

const EXTRACT_SYSTEM = `You write a modelschemas RateCard from a FAL model's llms.txt Pricing section.
Return JSON only. The card is JSONLogic over var, missing, +, -, *, /, max, min, if, ==, !=, <, <=, >, >=, and, or, ceil, floor, and lookup into named tables.
Rules:
- Every request-bound input.param MUST be one of the allowed request properties (or a dotted child of one). Usage-bound levers (input_tokens, output_tokens, …) are allowed when the text prices them.
- examples must be the page's own worked numbers, each with a quote copied from the text. verifyExamples must reproduce usd within 1%. Never invent examples.
- If the text has no worked examples, return {"unverified": true} — never a guessed card.
- If the text is zeros, empty, or "see pricing page" boilerplate, return {"unverified": true}.
- Optional top-level expiresAt (ISO datetime) when the text names a promo end.
Do not include a source object.`

function extractUserPrompt(
  pricingText: string,
  requestProperties: ReadonlySet<string>,
): string {
  const allowed = [...requestProperties].sort().join(', ')
  return `Allowed request properties: ${allowed || '(none)'}

Pricing section:
${pricingText}`
}

function withSource(
  body: z.infer<typeof extractedBodySchema>,
  args: ExtractCardArgs,
): RateCard {
  const { expiresAt, ...rest } = body
  return {
    ...rest,
    source: {
      url: args.sourceUrl,
      hash: args.sourceHash,
      extractedAt: new Date(args.now * 1000).toISOString(),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
  }
}

export async function extractRateCardWithGrok(
  args: ExtractCardArgs & { apiKey: string },
): Promise<ExtractedCard> {
  try {
    const response = await fetch(XAI_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: FAL_PRICING_EXTRACT_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM },
          {
            role: 'user',
            content: extractUserPrompt(
              args.pricingText,
              args.requestProperties,
            ),
          },
        ],
      }),
    })
    if (!response.ok) return null
    const content = chatContent((await response.json()) as unknown)
    if (content === null) return null
    const parsed = extractedResponseSchema.safeParse(parseJsonObject(content))
    if (!parsed.success) return null
    if ('unverified' in parsed.data) return 'unverified'
    if (parsed.data.examples.length === 0) return 'unverified'
    const card = withSource(parsed.data, args)
    if (verifyExamples(card).some((result) => !result.ok)) return null
    return card
  } catch {
    return null
  }
}

function logRefusal(
  providerId: string,
  rawId: string,
  reason: FalPricingExtractRefuse,
): void {
  console.error(
    JSON.stringify({
      job: 'fal-pricing-extract',
      providerId,
      rawId,
      error: 'rate_card_refused',
      reason,
    }),
  )
}

async function loadCursor(
  db: SyncDeps['db'],
  providerId: string,
): Promise<string | null> {
  const row = await db.query.cacheMeta.findFirst({
    where: eq(cacheMeta.key, falPricingExtractCursorKey(providerId)),
  })
  const cursor = row?.lastError
  return cursor && cursor.length > 0 ? cursor : null
}

async function saveCursor(
  db: SyncDeps['db'],
  providerId: string,
  cursor: string,
  now: number,
): Promise<void> {
  await db
    .insert(cacheMeta)
    .values({
      key: falPricingExtractCursorKey(providerId),
      fetchedAt: now,
      staleTime: 0,
      lastError: cursor,
    })
    .onConflictDoUpdate({
      target: cacheMeta.key,
      set: { fetchedAt: now, lastError: cursor },
    })
}

interface Candidate {
  id: string
  rawId: string
  pricing: unknown
  factSources: unknown
  schemaEndpointId: string | null
  boundId: string
}

async function loadCandidates(
  db: SyncDeps['db'],
  providerId: string,
): Promise<Array<Candidate>> {
  const rows = await db
    .select({
      id: models.id,
      rawId: models.rawId,
      pricing: models.pricing,
      factSources: models.factSources,
      schemaEndpointId: models.schemaEndpointId,
    })
    .from(models)
    .where(
      and(
        eq(models.providerId, providerId),
        isNotNull(models.activity),
        isNull(models.deprecatedAt),
      ),
    )
  const candidates: Array<Candidate> = []
  for (const row of rows) {
    const boundId = row.schemaEndpointId ?? row.rawId
    candidates.push({ ...row, boundId })
  }
  candidates.sort((a, b) =>
    a.rawId < b.rawId ? -1 : a.rawId > b.rawId ? 1 : 0,
  )
  return candidates
}

async function loadRequestProperties(
  db: SyncDeps['db'],
  providerId: string,
  boundIds: ReadonlyArray<string>,
): Promise<Map<string, Set<string>>> {
  const properties = new Map<string, Set<string>>()
  const dbIds = [...new Set(boundIds)].map((id) => `${providerId}/${id}`)
  for (let i = 0; i < dbIds.length; i += 90) {
    const chunk = dbIds.slice(i, i + 90)
    const versions = await db
      .select({
        endpointId: schemaVersions.endpointId,
        schema: schemaVersions.schema,
      })
      .from(schemaVersions)
      .where(
        and(
          inArray(schemaVersions.endpointId, chunk),
          eq(schemaVersions.kind, 'input'),
          isNull(schemaVersions.supersededAt),
        ),
      )
    const prefix = `${providerId}/`
    for (const version of versions) {
      const publicId = version.endpointId.startsWith(prefix)
        ? version.endpointId.slice(prefix.length)
        : version.endpointId
      const parsed: unknown = JSON.parse(version.schema)
      properties.set(publicId, requestSchemaPropertyNames(parsed))
    }
  }
  return properties
}

function docsExtractedSource(sources: ModelFactSources | null): {
  derivation: 'docs-extracted'
  sourceUrl?: string
  sourceHash?: string
  fetchedAt?: number
} {
  return {
    derivation: 'docs-extracted',
    ...(sources?.pricing?.sourceUrl
      ? { sourceUrl: sources.pricing.sourceUrl }
      : {}),
    ...(sources?.pricing?.sourceHash
      ? { sourceHash: sources.pricing.sourceHash }
      : {}),
    ...(sources?.pricing?.fetchedAt !== undefined
      ? { fetchedAt: sources.pricing.fetchedAt }
      : {}),
  }
}

async function writePricing(args: {
  db: SyncDeps['db']
  providerId: string
  candidate: Candidate
  card: RateCard | null
  sourceUrl: string
  sourceHash: string
  now: number
}): Promise<boolean> {
  const prior = factSourcesOf(args.candidate.factSources)
  const nextSources: ModelFactSources = {
    ...(prior ?? {}),
    pricing: {
      derivation: 'docs-extracted',
      sourceUrl: args.sourceUrl,
      sourceHash: args.sourceHash,
      fetchedAt: args.now,
    },
  }
  const before = args.candidate.pricing
  const changed = stableStringify(before) !== stableStringify(args.card)
  await args.db
    .update(models)
    .set({
      pricing: args.card,
      factSources: nextSources,
    })
    .where(eq(models.id, args.candidate.id))
  if (!changed) return false
  await args.db.insert(changes).values({
    id: crypto.randomUUID(),
    type: 'model.updated',
    providerId: args.providerId,
    subjectId: args.candidate.id,
    summary: `Model ${args.candidate.rawId} updated`,
    payload: { before: { pricing: before }, after: { pricing: args.card } },
    createdAt: args.now,
  })
  return true
}

async function stampPricingHash(args: {
  db: SyncDeps['db']
  candidate: Candidate
  sourceUrl: string
  sourceHash: string
  now: number
}): Promise<void> {
  const prior = factSourcesOf(args.candidate.factSources)
  await args.db
    .update(models)
    .set({
      factSources: {
        ...(prior ?? {}),
        pricing: {
          ...docsExtractedSource(prior),
          derivation: 'docs-extracted',
          sourceUrl: args.sourceUrl,
          sourceHash: args.sourceHash,
          fetchedAt: args.now,
        },
      },
    })
    .where(eq(models.id, args.candidate.id))
}

export async function extractFalPricing(
  deps: FalPricingExtractDeps,
): Promise<FalPricingExtractOutcome> {
  const providerId = deps.providerId ?? 'fal'
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000)
  const fetchCap = deps.fetchCap ?? FAL_PRICING_FETCH_CAP
  const extractCap = deps.extractCap ?? FAL_PRICING_EXTRACT_CAP
  const outcome: FalPricingExtractOutcome = {
    providerId,
    candidates: 0,
    fetched: 0,
    extracted: 0,
    written: 0,
    hashSkipped: 0,
    refused: 0,
    unverified: 0,
    fetchFailed: 0,
    cursor: null,
  }

  const apiKey = deps.secrets.XAI_API_KEY
  const extract =
    deps.extractCard ??
    (apiKey
      ? (args: ExtractCardArgs) => extractRateCardWithGrok({ ...args, apiKey })
      : null)

  if (extract === null) {
    outcome.skipped = 'XAI_API_KEY not set — skipped'
    return outcome
  }

  try {
    const all = await loadCandidates(deps.db, providerId)
    const properties = await loadRequestProperties(
      deps.db,
      providerId,
      all.map((row) => row.boundId),
    )
    const candidates = all.filter((row) => properties.has(row.boundId))
    outcome.candidates = candidates.length
    if (candidates.length === 0) return outcome

    const rawIds = candidates.map((row) => row.rawId)
    const cursor = await loadCursor(deps.db, providerId)
    let index = resumeIndex(rawIds, cursor)
    const start = index
    let lastProcessed: string | null = null
    let consecutiveFetchFails = 0
    let cursorFrozen = false
    const fetchLlms = deps.fetchText ?? fetchLlmsTxt

    const advance = (): boolean => {
      index = (index + 1) % candidates.length
      return index === start
    }

    do {
      const candidate = candidates[index]
      if (!candidate) break
      if (outcome.fetched >= fetchCap) break

      const sourceUrl = falLlmsTxtUrl(candidate.rawId)
      const fetched = llmsFetchOutcome(await fetchLlms(sourceUrl))
      outcome.fetched++

      if ('status' in fetched) {
        logFetchFailure(providerId, candidate.rawId, fetched.status)
        outcome.fetchFailed++
        if (isRetryableLlmsStatus(fetched.status)) {
          consecutiveFetchFails++
          cursorFrozen = true
          if (consecutiveFetchFails >= FAL_PRICING_FETCH_FAIL_ABORT) break
          if (advance()) break
          continue
        }
        consecutiveFetchFails = 0
        if (!cursorFrozen) lastProcessed = candidate.rawId
        if (advance()) break
        continue
      }

      consecutiveFetchFails = 0
      const text = fetched.text
      const section = pricingSection(text)
      const sectionHash = await pricingSectionHash(section)
      const existingCard = parseStoredRateCard(candidate.pricing)
      const sources = factSourcesOf(candidate.factSources)
      const storedHash = storedPricingHash(existingCard, sources)
      const hashSkip = shouldSkipExtract({
        storedHash,
        sectionHash,
        expiresAt: existingCard?.source.expiresAt,
        now,
      })

      if (isStubPricingSection(section)) {
        if (hashSkip) outcome.hashSkipped++
        else {
          logRefusal(providerId, candidate.rawId, 'stub')
          outcome.refused++
          if (
            await writePricing({
              db: deps.db,
              providerId,
              candidate,
              card: null,
              sourceUrl,
              sourceHash: sectionHash,
              now,
            })
          ) {
            outcome.written++
          }
        }
        if (!cursorFrozen) lastProcessed = candidate.rawId
        if (advance()) break
        continue
      }

      if (hashSkip) {
        outcome.hashSkipped++
        if (!cursorFrozen) lastProcessed = candidate.rawId
        if (advance()) break
        continue
      }

      if (outcome.extracted >= extractCap) break

      const requestProperties = properties.get(candidate.boundId) ?? new Set()
      outcome.extracted++
      const extracted = await extract({
        pricingText: section,
        requestProperties,
        sourceUrl,
        sourceHash: sectionHash,
        now,
      })

      if (extracted === 'unverified') {
        outcome.unverified++
        logRefusal(providerId, candidate.rawId, 'unverified')
        await stampPricingHash({
          db: deps.db,
          candidate,
          sourceUrl,
          sourceHash: sectionHash,
          now,
        })
        if (!cursorFrozen) lastProcessed = candidate.rawId
        if (advance()) break
        continue
      }

      if (extracted === null) {
        outcome.refused++
        logRefusal(providerId, candidate.rawId, 'uncompilable')
        if (!cursorFrozen) lastProcessed = candidate.rawId
        if (advance()) break
        continue
      }

      if (extracted.examples.length === 0) {
        outcome.unverified++
        logRefusal(providerId, candidate.rawId, 'unverified')
        await stampPricingHash({
          db: deps.db,
          candidate,
          sourceUrl,
          sourceHash: sectionHash,
          now,
        })
        if (!cursorFrozen) lastProcessed = candidate.rawId
        if (advance()) break
        continue
      }

      const stamped: RateCard = {
        ...extracted,
        source: {
          url: sourceUrl,
          hash: sectionHash,
          extractedAt: new Date(now * 1000).toISOString(),
          ...(extracted.source.expiresAt !== undefined
            ? { expiresAt: extracted.source.expiresAt }
            : {}),
        },
      }
      const stored = await storeListedPricing(stamped, {
        existing: candidate.pricing,
        requestProperties,
        sourceUrl,
        now,
      })
      if (stored.refused || stored.card === null) {
        outcome.refused++
        logRefusal(
          providerId,
          candidate.rawId,
          stored.refused ?? 'uncompilable',
        )
        if (!cursorFrozen) lastProcessed = candidate.rawId
        if (advance()) break
        continue
      }

      if (
        await writePricing({
          db: deps.db,
          providerId,
          candidate,
          card: stored.card,
          sourceUrl,
          sourceHash: sectionHash,
          now,
        })
      ) {
        outcome.written++
      }
      if (!cursorFrozen) lastProcessed = candidate.rawId
      if (advance()) break
    } while (outcome.fetched < fetchCap)

    if (lastProcessed !== null) {
      await saveCursor(deps.db, providerId, lastProcessed, now)
      outcome.cursor = lastProcessed
    } else {
      outcome.cursor = cursor
    }
    return outcome
  } catch (error) {
    outcome.error = errorMessage(error)
    console.error(
      JSON.stringify({
        job: 'fal-pricing-extract',
        providerId,
        error: outcome.error,
      }),
    )
    return outcome
  }
}
