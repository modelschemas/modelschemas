/**
 * The lockfile (PLAN.md task 12.3): `.manifest.json` in the out dir records
 * what was pulled (selection), from where, and each target's schema content
 * hash + ETag — so dev boots make ~zero requests, production builds verify
 * offline, and `update` re-fetches conditionally.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { OptionalStyle } from './pull.ts'
import type { ResolvedTarget } from './selection.ts'
import { KIND_LABEL } from './selection.ts'

export const MANIFEST_FILENAME = '.manifest.json'

export interface ManifestEntry {
  /** File path relative to the out dir. */
  path: string
  /** Schema content hash (the JSON ETag; types ETags embed it). */
  contentHash: string
  /** Verbatim response ETag, replayed as If-None-Match. */
  etag: string
}

export interface Manifest {
  version: 1
  baseUrl: string
  selections: Array<string>
  types: boolean
  optionalStyle: OptionalStyle
  /** Unix epoch seconds of the last pull that changed anything. */
  fetchedAt: number
  /** Keyed by target key (`provider/activity/endpointId#label`). */
  entries: Record<string, ManifestEntry>
}

export function targetKey(target: ResolvedTarget): string {
  return `${target.provider}/${target.activity}/${target.endpointId}#${KIND_LABEL[target.kind]}`
}

/** `anthropic/v1-messages.request.ts` — one file per endpoint+kind, slashes
 * in the endpoint id flattened so the layout stays one dir per provider. */
export function fileRelPath(target: ResolvedTarget): string {
  const flat = target.endpointId
    .replaceAll('/', '-')
    .replace(/[^A-Za-z0-9._{}-]/g, '-')
  return join(target.provider, `${flat}.${KIND_LABEL[target.kind]}.ts`)
}

export async function readManifest(outDir: string): Promise<Manifest | null> {
  let text: string
  try {
    text = await readFile(join(outDir, MANIFEST_FILENAME), 'utf8')
  } catch {
    return null
  }
  const parsed = JSON.parse(text) as Omit<Manifest, 'version'> & {
    version: number
  }
  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported manifest version in ${join(outDir, MANIFEST_FILENAME)} — regenerate with \`modelschemas pull\`.`,
    )
  }
  return { ...parsed, version: 1 }
}

export async function writeManifest(
  outDir: string,
  manifest: Manifest,
): Promise<void> {
  await atomicWrite(
    join(outDir, MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

/** Write via a sibling temp file + rename so builds never see half a file. */
export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid.toString(36)}`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}
