#!/usr/bin/env bun
/**
 * Public git mirror of the catalog (issue #343). Fetches
 * `GET /v1/admin/export`, writes one file per entity into a data repo
 * checkout, and prints the commit message on stdout:
 *
 *   providers/<provider>.json
 *   models/<provider>/<modelId>.json
 *   schemas/<provider>/<endpointId>.json
 *   latest-change.json   the newest /v1/changes row the files include
 *
 * The export already leaves out per-poll fields and sorts keys; files here
 * are pretty-printed with a trailing newline, so the same export always
 * writes the same bytes. The three entity folders are rewritten from
 * scratch, so a removed entity shows up as a deleted file.
 *
 * The message lists the /v1/changes ids after the previous
 * `latest-change.json` up to the new one. Admin-keyed requests skip the
 * rate limit, so paging the feed is free.
 *
 * Self-contained (no repo imports): the data repo's workflow runs it from a
 * sparse checkout of this file (scripts/mirror/catalog-mirror.yml).
 *
 *   MODELSCHEMAS_ADMIN_KEY=… bun scripts/mirror-catalog.ts <data-repo-dir>
 *   MODELSCHEMAS_URL defaults to https://modelschemas.openstory.workers.dev
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface ChangeRef {
  id: string
  createdAt: number
}

interface ExportBody {
  latestChange: ChangeRef | null
  providers: Array<{ id: string }>
  models: Array<{ id: string; provider: string }>
  schemas: Array<{ provider: string; endpointId: string }>
}

interface FeedChange extends ChangeRef {
  type: string
  summary: string
}

export const ENTITY_DIRS = ['providers', 'models', 'schemas'] as const
export const LATEST_CHANGE_FILE = 'latest-change.json'

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Ids become path segments; refuse anything that could leave its folder. */
function safeSegments(id: string): string {
  const parts = id.split('/')
  if (
    id === '' ||
    id.includes('\\') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`mirror: unsafe id for a file path: ${JSON.stringify(id)}`)
  }
  return id
}

/** Every mirror file (path → contents) for one export body. */
export function mirrorFiles(body: ExportBody): Map<string, string> {
  const files = new Map<string, string>()
  const add = (path: string, value: unknown) => {
    if (files.has(path)) throw new Error(`mirror: two entities write ${path}`)
    files.set(path, pretty(value))
  }
  for (const provider of body.providers) {
    add(`providers/${safeSegments(provider.id)}.json`, provider)
  }
  for (const model of body.models) {
    add(
      `models/${safeSegments(model.provider)}/${safeSegments(model.id)}.json`,
      model,
    )
  }
  for (const schema of body.schemas) {
    add(
      `schemas/${safeSegments(schema.provider)}/${safeSegments(schema.endpointId)}.json`,
      schema,
    )
  }
  files.set(LATEST_CHANGE_FILE, pretty(body.latestChange))
  return files
}

/** The feed's order: newest first by createdAt, then id. */
function after(a: ChangeRef, b: ChangeRef): boolean {
  return (
    a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id)
  )
}

/**
 * Changes in (previous, latest], newest first, from feed pages that are
 * newest first. Stops at the first change at or before `previous`.
 */
export async function coveredChanges(
  pages: AsyncIterable<Array<FeedChange>>,
  previous: ChangeRef,
  latest: ChangeRef,
): Promise<Array<FeedChange>> {
  const covered: Array<FeedChange> = []
  for await (const page of pages) {
    for (const change of page) {
      if (!after(change, previous)) return covered
      if (!after(change, latest)) covered.push(change)
    }
  }
  return covered
}

export function commitMessage(
  previous: ChangeRef | null,
  latest: ChangeRef | null,
  covered: Array<FeedChange>,
): string {
  if (latest === null) return 'Catalog snapshot (no changes recorded yet)\n'
  if (previous === null) return `Catalog snapshot up to change ${latest.id}\n`
  if (covered.length === 0) return 'Catalog refresh (no new /v1/changes)\n'
  const lines = covered.map((c) => `- ${c.id} ${c.type}: ${c.summary}`)
  return `Catalog: ${covered.length} change${covered.length === 1 ? '' : 's'} up to ${latest.id}\n\n/v1/changes ids covered:\n${lines.join('\n')}\n`
}

async function main() {
  const [dir] = process.argv.slice(2)
  const adminKey = process.env.MODELSCHEMAS_ADMIN_KEY
  if (!dir || !adminKey) {
    throw new Error(
      'usage: MODELSCHEMAS_ADMIN_KEY=… bun scripts/mirror-catalog.ts <data-repo-dir>',
    )
  }
  const base =
    process.env.MODELSCHEMAS_URL ?? 'https://modelschemas.openstory.workers.dev'
  const get = async (path: string) => {
    const response = await fetch(new URL(path, base), {
      headers: { 'X-Admin-Key': adminKey },
    })
    if (!response.ok) {
      throw new Error(
        `GET ${path}: ${response.status} ${await response.text()}`,
      )
    }
    return response
  }

  const previousText = await readFile(
    join(dir, LATEST_CHANGE_FILE),
    'utf8',
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return 'null'
    throw error
  })
  const previous = JSON.parse(previousText) as ChangeRef | null

  // A stream error mid-body makes this throw, so a cut export writes nothing.
  const body = (await (await get('/v1/admin/export')).json()) as ExportBody
  const files = mirrorFiles(body)

  // Read the feed before touching the tree: a failure leaves it as it was.
  const latest = body.latestChange
  const covered =
    previous && latest
      ? await coveredChanges(
          (async function* () {
            let next: string | null =
              `/v1/changes?since=${previous.createdAt}&limit=200`
            while (next) {
              const page = (await (await get(next)).json()) as {
                changes: Array<FeedChange>
                nextCursor: string | null
              }
              yield page.changes
              next = page.nextCursor
                ? `/v1/changes?since=${previous.createdAt}&limit=200&cursor=${encodeURIComponent(page.nextCursor)}`
                : null
            }
          })(),
          previous,
          latest,
        )
      : []

  for (const entity of ENTITY_DIRS) {
    await rm(join(dir, entity), { recursive: true, force: true })
  }
  for (const [path, contents] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), contents)
  }
  process.stdout.write(commitMessage(previous, latest, covered))
}

if (import.meta.main) await main()
