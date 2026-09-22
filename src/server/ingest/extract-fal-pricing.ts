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
import { compileFalUnitCard, usdAmounts } from './fal-unit-rate.ts'
import { markdownSection } from '#/server/providers/model-facts.ts'
import { requestSchemaPropertyNames } from '#/server/providers/fact-sources.ts'
import type { ModelFactSources } from '#/server/providers/types.ts'
import { sha256Text } from '#/server/providers/types.ts'
import { stableStringify } from '#/server/kv.ts'
import { parseStoredRateCard, storeListedPricing } from '#/server/rate-card.ts'
import type { RateCardRefuse } from '#/server/rate-card.ts'
import type { SyncDeps } from './sync.ts'

/**
 * Own invocations, after the 05:00–05:30 spec-sync shards. Six hourly
 * firings so the whole FAL roster fits in one calendar day within the
 * per-invocation subrequest budget. Keep in lockstep with `wrangler.jsonc`
 * `triggers.crons` (unit-tested).
 */
export const FAL_PRICING_EXTRACT_CRONS = [
  '0 6 * * *',
  '0 7 * * *',
  '0 8 * * *',
  '0 9 * * *',
  '0 10 * * *',
  '0 11 * * *',
] as const

/** ~250 llms.txt fetches + leftovers stays well under the 1000 limit. */
export const FAL_PRICING_FETCH_CAP = 250
export const FAL_PRICING_EXTRACT_CAP = 40
/** llms.txt fetches in flight at once. */
export const FAL_PRICING_FETCH_CONCURRENCY = 20
/** Extract calls in flight at once. */
export const FAL_PRICING_EXTRACT_CONCURRENCY = 5
/** Consecutive 408/429/5xx/network failures before the run stops walking. */
export const FAL_PRICING_FETCH_FAIL_ABORT = 8

export const FAL_PRICING_EXTRACT_CURSOR_KEY = 'fal-pricing-extract-cursor'

export function falPricingExtractCursorKey(providerId = 'fal'): string {
  return `${FAL_PRICING_EXTRACT_CURSOR_KEY}:${providerId}`
}

/** Single extract model — fail-closed; never a second guess. */
export const FAL_PRICING_EXTRACT_MODEL = 'grok-4-fast'

const XAI_CHAT_URL = 'https://api.x.ai/v1/chat/completions'

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
  /** Cards built by the unit-rate parser, no model call. */
  compiled: number
  /** Rows filled by copying a card already known for that section hash. */
  deduped: number
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

/**
 * No positive dollar amount — empty, boilerplate, or zeros. Bold and
 * suffix-`$` spellings (`$**0.04**`, `**0.17** $`) are real prices, not
 * stubs (issue #70).
 */
export function isStubPricingSection(section: string): boolean {
  return usdAmounts(section).length === 0
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
- Every request-bound input.param MUST be one of the allowed request properties (or a dotted child of one). Usage-bound levers (input_tokens, output_tokens, seconds, megapixels, ...) are allowed when the text prices them; make a quantity the request cannot state usage-bound rather than inventing a request field.
- A quoted unit rate IS enough. "$0.045 per second of video" is a worked number: emit one example of one unit (params {"seconds": 1}, usd 0.045) whose quote is copied verbatim from the text. "per 1000 characters" means one example of 1000 units at the quoted price.
- Prefer the page's own worked total when it states one ("a 5 second video costs $0.70"). Every example's quote must be text copied from the section, and verifyExamples must reproduce usd within 1%.
- If the text names no price at all, is zeros, or is "see pricing page" boilerplate, return {"unverified": true} — never a guessed card.
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

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, TResult>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<TResult>,
): Promise<Array<TResult>> {
  const out = new Array<TResult>(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (let i = next++; i < items.length; i = next++) {
        out[i] = await fn(items[i] as T)
      }
    },
  )
  await Promise.all(workers)
  return out
}

interface LeftoverGroup {
  section: string
  sourceUrl: string
  rows: Array<Candidate>
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
    compiled: 0,
    deduped: 0,
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

    // Cards already stored against a Pricing-section hash — reused across
    // rows in this run and across nights, so the model is never asked
    // twice for the same text.
    const byHash = new Map<string, RateCard>()
    for (const row of candidates) {
      const card = parseStoredRateCard(row.pricing)
      // A promo card past its expiresAt must be re-read, not copied on.
      if (!card) continue
      const expiresAt = card.source.expiresAt
      if (expiresAt !== undefined && Date.parse(expiresAt) <= now * 1000) {
        continue
      }
      byHash.set(card.source.hash, card)
    }

    const requestPropertiesOf = (candidate: Candidate): ReadonlySet<string> =>
      properties.get(candidate.boundId) ?? new Set<string>()

    const applyCard = async (
      candidate: Candidate,
      card: RateCard,
      sourceUrl: string,
      sectionHash: string,
    ): Promise<void> => {
      const stamped: RateCard = {
        ...card,
        source: {
          ...card.source,
          url: sourceUrl,
          hash: sectionHash,
          extractedAt: new Date(now * 1000).toISOString(),
        },
      }
      const stored = await storeListedPricing(stamped, {
        existing: candidate.pricing,
        requestProperties: requestPropertiesOf(candidate),
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
        return
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
    }

    const rawIds = candidates.map((row) => row.rawId)
    const cursor = await loadCursor(deps.db, providerId)
    const start = resumeIndex(rawIds, cursor)
    const order = [...candidates.slice(start), ...candidates.slice(0, start)]

    // Held in an object: `mark` assigns it from a closure, where TS's
    // control-flow analysis would otherwise keep narrowing it to null.
    const walked: { last: string | null } = { last: null }
    let consecutiveFetchFails = 0
    let cursorFrozen = false
    const fetchLlms = deps.fetchText ?? fetchLlmsTxt
    const leftovers = new Map<string, LeftoverGroup>()

    // llms.txt is pure I/O — fetch a window ahead so a shard is not 250
    // sequential round trips. Order of processing is unchanged.
    const buffer = new Map<number, FalLlmsFetchResult>()
    const fetchAt = async (i: number): Promise<FalLlmsFetchResult> => {
      const cached = buffer.get(i)
      if (cached !== undefined) return cached
      const width = Math.max(
        1,
        Math.min(FAL_PRICING_FETCH_CONCURRENCY, fetchCap - i, order.length - i),
      )
      const results = await Promise.all(
        order
          .slice(i, i + width)
          .map((row) => fetchLlms(falLlmsTxtUrl(row.rawId))),
      )
      results.forEach((result, k) => buffer.set(i + k, result))
      return results[0] as FalLlmsFetchResult
    }

    for (let i = 0; i < order.length && outcome.fetched < fetchCap; i++) {
      const candidate = order[i] as Candidate
      const mark = (): void => {
        if (!cursorFrozen) walked.last = candidate.rawId
      }

      const sourceUrl = falLlmsTxtUrl(candidate.rawId)
      const fetched = llmsFetchOutcome(await fetchAt(i))
      outcome.fetched++

      if ('status' in fetched) {
        logFetchFailure(providerId, candidate.rawId, fetched.status)
        outcome.fetchFailed++
        if (isRetryableLlmsStatus(fetched.status)) {
          consecutiveFetchFails++
          cursorFrozen = true
          if (consecutiveFetchFails >= FAL_PRICING_FETCH_FAIL_ABORT) break
          continue
        }
        consecutiveFetchFails = 0
        mark()
        continue
      }

      consecutiveFetchFails = 0
      const section = pricingSection(fetched.text)
      const sectionHash = await pricingSectionHash(section)
      const existingCard = parseStoredRateCard(candidate.pricing)
      const sources = factSourcesOf(candidate.factSources)
      if (
        shouldSkipExtract({
          storedHash: storedPricingHash(existingCard, sources),
          sectionHash,
          expiresAt: existingCard?.source.expiresAt,
          now,
        })
      ) {
        outcome.hashSkipped++
        mark()
        continue
      }

      if (isStubPricingSection(section)) {
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
        mark()
        continue
      }

      const known = byHash.get(sectionHash)
      if (known) {
        outcome.deduped++
        await applyCard(candidate, known, sourceUrl, sectionHash)
        mark()
        continue
      }

      const compiled = compileFalUnitCard(
        section,
        requestPropertiesOf(candidate),
        {
          url: sourceUrl,
          hash: sectionHash,
          extractedAt: new Date(now * 1000).toISOString(),
        },
      )
      if (compiled) {
        outcome.compiled++
        byHash.set(sectionHash, compiled)
        await applyCard(candidate, compiled, sourceUrl, sectionHash)
        mark()
        continue
      }

      const group = leftovers.get(sectionHash)
      if (group) {
        group.rows.push(candidate)
        mark()
        continue
      }
      // The cap counts distinct sections, not rows — a row joining a
      // section already queued is free. Stop before marking so the next
      // shard resumes on this row.
      if (leftovers.size >= extractCap) break
      leftovers.set(sectionHash, { section, sourceUrl, rows: [candidate] })
      mark()
    }

    if (walked.last !== null) {
      await saveCursor(deps.db, providerId, walked.last, now)
      outcome.cursor = walked.last
    } else {
      outcome.cursor = cursor
    }

    // Everything the parser could not stand behind: one extract call per
    // distinct Pricing section, then copied onto every row sharing it.
    if (leftovers.size === 0) return outcome
    if (extract === null) {
      outcome.skipped = 'XAI_API_KEY not set — leftovers skipped'
      return outcome
    }

    const groups = [...leftovers.entries()]
    const results = await mapLimit(
      groups,
      FAL_PRICING_EXTRACT_CONCURRENCY,
      async ([hash, group]) => {
        outcome.extracted++
        return await extract({
          pricingText: group.section,
          requestProperties: requestPropertiesOf(group.rows[0] as Candidate),
          sourceUrl: group.sourceUrl,
          sourceHash: hash,
          now,
        })
      },
    )

    for (const [index, [hash, group]] of groups.entries()) {
      const result = results[index]
      if (result === null || result === undefined) {
        for (const row of group.rows) {
          outcome.refused++
          logRefusal(providerId, row.rawId, 'uncompilable')
        }
        continue
      }
      if (result === 'unverified' || result.examples.length === 0) {
        for (const row of group.rows) {
          outcome.unverified++
          logRefusal(providerId, row.rawId, 'unverified')
          await stampPricingHash({
            db: deps.db,
            candidate: row,
            sourceUrl: falLlmsTxtUrl(row.rawId),
            sourceHash: hash,
            now,
          })
        }
        continue
      }
      byHash.set(hash, result)
      for (const row of group.rows) {
        await applyCard(row, result, falLlmsTxtUrl(row.rawId), hash)
      }
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
