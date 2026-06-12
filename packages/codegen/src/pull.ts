/**
 * Pull core (PLAN.md task 12.3). `pull()` expands selections against the
 * live catalog and writes generated modules + the manifest; `verify()` is
 * the zero-network production-build check; `checkUpdates()` is the one
 * cheap dev-boot call that reports upstream drift without rewriting
 * anything.
 */
import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { KIND_LABEL, matchTargets, parseSelection } from './selection.ts'
import type { ResolvedTarget } from './selection.ts'
import {
  atomicWrite,
  fileRelPath,
  readManifest,
  targetKey,
  writeManifest,
} from './manifest.ts'
import type { Manifest, ManifestEntry } from './manifest.ts'

export type OptionalStyle = 'exact' | 'undefined'

export interface PullConfig {
  /** Service origin; defaults to the production deployment. */
  baseUrl?: string
  /** Optional API key — lifts anonymous rate limits. */
  apiKey?: string
  /** Directory the generated files + manifest live in (committed). */
  outDir: string
  /** Selection strings, e.g. `anthropic/v1/messages#request`, `gemini/*`. */
  selections: Array<string>
  /** Pull TypeScript modules (default) or schema-const-only modules. */
  types?: boolean
  optionalStyle?: OptionalStyle
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
  log?: (message: string) => void
}

export const DEFAULT_BASE_URL = 'https://modelschemas.com'

interface Resolved {
  baseUrl: string
  apiKey: string | undefined
  outDir: string
  selections: Array<string>
  types: boolean
  optionalStyle: OptionalStyle
  fetchImpl: typeof fetch
  log: (message: string) => void
}

function resolve(config: PullConfig): Resolved {
  return {
    baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    apiKey: config.apiKey,
    outDir: config.outDir,
    selections: config.selections,
    types: config.types ?? true,
    optionalStyle: config.optionalStyle ?? 'exact',
    fetchImpl: config.fetchImpl ?? fetch,
    log: config.log ?? (() => undefined),
  }
}

function authHeaders(cfg: Resolved): Record<string, string> {
  return cfg.apiKey !== undefined
    ? { Authorization: `Bearer ${cfg.apiKey}` }
    : {}
}

async function fetchJson<T>(cfg: Resolved, path: string): Promise<T> {
  const response = await cfg.fetchImpl(`${cfg.baseUrl}${path}`, {
    headers: authHeaders(cfg),
  })
  if (!response.ok) {
    throw new Error(`GET ${path} → ${String(response.status)}`)
  }
  return (await response.json()) as T
}

/** Expand every selection into concrete targets via the provider indexes. */
export async function expandSelections(
  config: PullConfig,
): Promise<Array<ResolvedTarget>> {
  const cfg = resolve(config)
  const parsed = config.selections.map(parseSelection)
  const providers = [...new Set(parsed.map((s) => s.provider))]
  const indexes = new Map<
    string,
    { provider: string; activities: Record<string, Array<string>> }
  >()
  for (const provider of providers) {
    indexes.set(
      provider,
      await fetchJson(cfg, `/v1/schemas/${encodeURIComponent(provider)}`),
    )
  }
  const seen = new Set<string>()
  const targets: Array<ResolvedTarget> = []
  for (const selection of parsed) {
    const index = indexes.get(selection.provider)
    if (index === undefined) continue
    for (const target of matchTargets(selection, index)) {
      const key = targetKey(target)
      if (seen.has(key)) continue
      seen.add(key)
      targets.push(target)
    }
  }
  return targets
}

function schemaUrlPath(cfg: Resolved, target: ResolvedTarget): string {
  const base = `/v1/schemas/${encodeURIComponent(target.provider)}/${encodeURIComponent(target.activity)}/${target.endpointId.split('/').map(encodeURIComponent).join('/')}`
  const params = new URLSearchParams({ kind: target.kind })
  if (cfg.types) {
    params.set('format', 'types')
    params.set('optional', cfg.optionalStyle)
  }
  return `${base}?${params.toString()}`
}

/** Schema content hash from a types ETag (`<hash>-types-v<N>-<style>`). */
function hashFromTypesEtag(etag: string): string {
  const bare = etag.replace(/^W\//, '').replace(/^"|"$/g, '')
  const cut = bare.indexOf('-types-v')
  return cut === -1 ? bare : bare.slice(0, cut)
}

function pascal(text: string): string {
  const name = text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  if (name === '') return 'Schema'
  return /^[0-9]/.test(name) ? `_${name}` : name
}

/** Schema-const-only module for `types: false` pulls — same banner and
 * export-name conventions as the server's `?format=types` output. */
function schemaOnlyModule(
  target: ResolvedTarget,
  contentHash: string,
  schema: unknown,
  sourceUrl: string,
): string {
  const kindLabel = target.kind === 'input' ? 'Request' : 'Response'
  const root = pascal(target.provider) + pascal(target.endpointId) + kindLabel
  const constName = `${root.charAt(0).toLowerCase()}${root.slice(1)}Schema`
  return [
    `// @generated by modelschemas — do not edit; refresh with \`modelschemas update\`.`,
    `// provider: ${target.provider} · endpoint: ${target.endpointId} · kind: ${target.kind}`,
    `// source: ${sourceUrl}`,
    `// schema version: ${contentHash}`,
    ``,
    `export type JsonSchema = { readonly [key: string]: unknown }`,
    ``,
    `export const ${constName}: JsonSchema = ${JSON.stringify(schema, null, 2)}`,
    ``,
  ].join('\n')
}

/** Format with the *user's* prettier (their config) when it's installed;
 * otherwise return the canonical text untouched. */
async function maybePrettier(path: string, text: string): Promise<string> {
  try {
    const prettier = await import('prettier')
    const config = await prettier.resolveConfig(path)
    return await prettier.format(text, {
      ...(config ?? {}),
      parser: 'typescript',
    })
  } catch {
    return text
  }
}

export interface PullSummary {
  written: Array<string>
  unchanged: Array<string>
  /** Implicit-kind targets the server has no schema for. */
  skipped: Array<string>
  failed: Array<{ key: string; reason: string }>
}

export interface PullOptions {
  /** Only fetch targets whose file or manifest entry is missing (dev boot). */
  missingOnly?: boolean
  /** Injectable clock (unix epoch seconds). */
  now?: () => number
}

export async function pull(
  config: PullConfig,
  options: PullOptions = {},
): Promise<PullSummary> {
  const cfg = resolve(config)
  const previous = await readManifest(cfg.outDir)
  const entries: Record<string, ManifestEntry> = {}
  const summary: PullSummary = {
    written: [],
    unchanged: [],
    skipped: [],
    failed: [],
  }

  const targets = await expandSelections(config)
  let changed = false
  for (const target of targets) {
    const key = targetKey(target)
    const relPath = fileRelPath(target)
    const absPath = join(cfg.outDir, relPath)
    const prior = previous?.entries[key]
    const fileExists = await access(absPath).then(
      () => true,
      () => false,
    )

    if (options.missingOnly === true && prior !== undefined && fileExists) {
      entries[key] = prior
      summary.unchanged.push(key)
      continue
    }

    const path = schemaUrlPath(cfg, target)
    let response: Response
    try {
      response = await cfg.fetchImpl(`${cfg.baseUrl}${path}`, {
        headers: {
          ...authHeaders(cfg),
          ...(prior !== undefined && fileExists
            ? { 'If-None-Match': prior.etag }
            : {}),
        },
      })
    } catch (error) {
      summary.failed.push({
        key,
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (response.status === 304 && prior !== undefined) {
      entries[key] = prior
      summary.unchanged.push(key)
      continue
    }
    if (response.status === 404) {
      if (target.explicitKind) {
        summary.failed.push({
          key,
          reason: `404 — no ${KIND_LABEL[target.kind]} schema for '${target.selector}'.`,
        })
      } else {
        summary.skipped.push(key)
      }
      continue
    }
    if (!response.ok) {
      summary.failed.push({
        key,
        reason: `GET ${path} → ${String(response.status)}`,
      })
      continue
    }

    const etag = response.headers.get('etag') ?? ''
    const sourceUrl = `${cfg.baseUrl}${path}`
    let text: string
    let contentHash: string
    if (cfg.types) {
      text = await response.text()
      contentHash = hashFromTypesEtag(etag)
    } else {
      const body = (await response.json()) as {
        contentHash: string
        schema: unknown
      }
      contentHash = body.contentHash
      text = schemaOnlyModule(target, contentHash, body.schema, sourceUrl)
    }
    await atomicWrite(absPath, await maybePrettier(absPath, text))
    entries[key] = { path: relPath, contentHash, etag }
    summary.written.push(key)
    changed = true
    cfg.log(`pulled ${key} → ${relPath}`)
  }

  const now = options.now?.() ?? Math.floor(Date.now() / 1000)
  const manifest: Manifest = {
    version: 1,
    baseUrl: cfg.baseUrl,
    selections: cfg.selections,
    types: cfg.types,
    optionalStyle: cfg.optionalStyle,
    fetchedAt: changed ? now : (previous?.fetchedAt ?? now),
    entries,
  }
  if (
    changed ||
    previous === null ||
    JSON.stringify(previous) !== JSON.stringify(manifest)
  ) {
    await writeManifest(cfg.outDir, manifest)
  }
  return summary
}

export interface VerifyResult {
  ok: boolean
  problems: Array<string>
}

/** Offline check for production builds: the manifest exists, covers the
 * configured selections, and every generated file is present. */
export async function verify(config: PullConfig): Promise<VerifyResult> {
  const cfg = resolve(config)
  const problems: Array<string> = []
  const manifest = await readManifest(cfg.outDir)
  if (manifest === null) {
    return {
      ok: false,
      problems: [
        `No ${cfg.outDir}/.manifest.json — run \`modelschemas pull\` (or boot the dev server) and commit the generated files.`,
      ],
    }
  }
  for (const selection of cfg.selections) {
    if (!manifest.selections.includes(selection)) {
      problems.push(
        `Selection '${selection}' is not in the manifest — run \`modelschemas pull\` and commit the result.`,
      )
    }
  }
  for (const [key, entry] of Object.entries(manifest.entries)) {
    const exists = await access(join(cfg.outDir, entry.path)).then(
      () => true,
      () => false,
    )
    if (!exists) {
      problems.push(
        `Missing generated file ${entry.path} (${key}) — run \`modelschemas pull\`.`,
      )
    }
  }
  return { ok: problems.length === 0, problems }
}

export interface UpstreamUpdate {
  key: string
  contentHash: string
  summary: string
}

/** One cheap call per provider against `/v1/changes` — reports entries whose
 * upstream schema hash moved past the manifest. Never rewrites files. */
export async function checkUpdates(
  config: PullConfig,
): Promise<Array<UpstreamUpdate>> {
  const cfg = resolve(config)
  const manifest = await readManifest(cfg.outDir)
  if (manifest === null) return []

  // entry lookup by `subjectId#label` (subjectId is `provider/endpointId`).
  const bySubject = new Map<string, { key: string; entry: ManifestEntry }>()
  for (const [key, entry] of Object.entries(manifest.entries)) {
    const hashIndex = key.indexOf('#')
    if (hashIndex === -1) continue
    const label = key.slice(hashIndex + 1)
    const [provider, , ...endpoint] = key.slice(0, hashIndex).split('/')
    if (provider === undefined) continue
    bySubject.set(`${provider}/${endpoint.join('/')}#${label}`, { key, entry })
  }

  const providers = [
    ...new Set(
      Object.keys(manifest.entries).flatMap((key) => {
        const provider = key.split('/')[0]
        return provider !== undefined ? [provider] : []
      }),
    ),
  ]
  const updates: Array<UpstreamUpdate> = []
  const reported = new Set<string>()
  for (const provider of providers) {
    const result = await fetchJson<{
      changes: Array<{
        type: string
        subjectId: string | null
        summary: string
        payload?: { kind?: string; contentHash?: string } | null
      }>
      nextCursor: string | null
    }>(
      cfg,
      `/v1/changes?provider=${encodeURIComponent(String(provider))}&type=schema.updated&since=${String(manifest.fetchedAt)}&limit=200`,
    )
    if (result.nextCursor !== null) {
      cfg.log(
        `more than one page of upstream changes for ${String(provider)} — run \`modelschemas update\`.`,
      )
    }
    for (const change of result.changes) {
      const kind = change.payload?.kind
      const hash = change.payload?.contentHash
      if (change.subjectId === null || kind === undefined || hash === undefined)
        continue
      const label = kind === 'input' ? 'request' : 'response'
      const match = bySubject.get(`${change.subjectId}#${label}`)
      if (
        match !== undefined &&
        match.entry.contentHash !== hash &&
        !reported.has(match.key)
      ) {
        // Newest first — the first hit per key is the current upstream hash.
        reported.add(match.key)
        updates.push({
          key: match.key,
          contentHash: hash,
          summary: change.summary,
        })
      }
    }
  }
  return updates
}
