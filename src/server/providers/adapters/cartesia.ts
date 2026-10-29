/**
 * Cartesia — real-time TTS/STT. No public OpenAPI file: the Stainless GCS
 * spec was removed (issue #512) and `docs.cartesia.ai/<version>/api.yml`
 * is login-gated. Each public API-reference page's `.md` embeds its one
 * operation from that `api.yml` (plus the components it references) in an
 * `## OpenAPI` block; fetchSpec merges those blocks into one document.
 * Voices stand in for models. Requests need a Cartesia-Version header.
 *
 * No per-voice USD rate. https://docs.cartesia.ai/pricing meters credits
 * (about 1 per character, or per second of audio) and
 * https://cartesia.ai/pricing sells those credits in plan bundles. The
 * Scale-plan "$0.39 per hour" Ink line is not the rate on every plan, so
 * every voice stays null (issue #121).
 */
import type { Activity } from '#/db/schema.ts'
import { normalizeMediaModalities } from '../media-modalities.ts'
import { isoToEpochSeconds } from '../release-dates.ts'
import { fetchJson, fetchText, sha256Text, skippedResult } from '../types.ts'
import type {
  ListModelsResult,
  OpenApiDocument,
  ProviderConfig,
  ProviderSecrets,
  SpecFetchResult,
} from '../types.ts'

export const CARTESIA_VERSION = '2026-03-01'
/** Mintlify's index of every API page (linked from docs.cartesia.ai/llms.txt). */
export const CARTESIA_API_INDEX_URL =
  'https://docs.cartesia.ai/_llms/en/api.txt'
export const CARTESIA_VOICES_URL = 'https://api.cartesia.ai/voices'

const PAGE_PREFIX = `https://docs.cartesia.ai/${CARTESIA_VERSION}/api-reference/`
const BLOCK_RE = new RegExp(
  `^\`{4}yaml ${CARTESIA_VERSION}/api\\.yml [^\\n]*\\n([\\s\\S]*?)^\`{4}$`,
  'm',
)
const ASYNCAPI_MARKER = `\`\`\`\`yaml ${CARTESIA_VERSION}/asyncapi.yml `

function pathMatches(path: string, prefix: string): boolean {
  const bare = path.split('?')[0] ?? path
  return bare === prefix || bare.startsWith(`${prefix}/`)
}

/**
 * Generation surface is TTS, STT, and infill (the 2026-03-01 docs no
 * longer list voice-changer; the match stays for older stored rows).
 * Agents, voice library admin, datasets, fine-tunes, files, and auth
 * classify null.
 */
function classify(path: string): Activity | null {
  if (
    pathMatches(path, '/tts') ||
    pathMatches(path, '/stt') ||
    pathMatches(path, '/infill') ||
    pathMatches(path, '/voice-changer') ||
    pathMatches(path, '/audio/transcriptions')
  ) {
    return 'audio'
  }
  return null
}

/** The versioned API-reference page URLs listed in the API index. */
function apiPageUrls(index: string): Array<string> {
  const urls = new Set<string>()
  for (const [, url] of index.matchAll(/\((https:\/\/[^)\s]+\.md)\)/g)) {
    if (url?.startsWith(PAGE_PREFIX)) urls.add(url)
  }
  return [...urls].sort()
}

/**
 * A page's `api.yml` block, or null for an AsyncAPI websocket page. A page
 * with neither throws: a renamed block must not drop its endpoint silently.
 */
function openApiBlock(url: string, page: string): string | null {
  const block = BLOCK_RE.exec(page)?.[1]
  if (block) return block
  if (page.includes(ASYNCAPI_MARKER)) return null
  throw new Error(`cartesia: ${url} has no ${CARTESIA_VERSION} api.yml block`)
}

type Section = Record<string, unknown>

/**
 * Merge per-operation documents. The pages are cut from one `api.yml`, so
 * a path or component name seen twice must carry the same value; a
 * mismatch throws rather than picking one.
 */
function mergeOperationDocs(
  docs: Array<{ url: string; doc: OpenApiDocument }>,
): OpenApiDocument {
  const first = docs[0]?.doc
  if (!first) throw new Error('cartesia: no api.yml blocks in the API pages')
  const paths: Record<string, Section> = {}
  const components: Record<string, Section> = {}
  const put = (into: Section, key: string, value: unknown, where: string) => {
    if (key in into && JSON.stringify(into[key]) !== JSON.stringify(value)) {
      throw new Error(`cartesia: ${where} ${key} differs between API pages`)
    }
    into[key] = value
  }
  for (const { url, doc } of docs) {
    if (typeof doc.openapi !== 'string' || !doc.paths) {
      throw new Error(`cartesia: ${url} OpenAPI block is not OpenAPI`)
    }
    for (const [path, item] of Object.entries(
      doc.paths as Record<string, Section>,
    )) {
      paths[path] ??= {}
      for (const [method, op] of Object.entries(item)) {
        put(paths[path], method, op, path)
      }
    }
    const comps = (doc.components ?? {}) as Record<string, Section>
    for (const [kind, entries] of Object.entries(comps)) {
      components[kind] ??= {}
      for (const [name, value] of Object.entries(entries)) {
        put(components[kind], name, value, `components.${kind}`)
      }
    }
  }
  return { ...first, paths, components } as OpenApiDocument
}

async function fetchSpec(_env: ProviderSecrets): Promise<SpecFetchResult> {
  const { parse } = await import('yaml')
  const urls = apiPageUrls(await fetchText(CARTESIA_API_INDEX_URL))
  if (urls.length === 0) {
    throw new Error(
      `cartesia: no ${PAGE_PREFIX} pages in ${CARTESIA_API_INDEX_URL}`,
    )
  }
  const pages = await Promise.all(
    urls.map(async (url) => ({
      url,
      block: openApiBlock(url, await fetchText(url)),
    })),
  )
  const blocks = pages.filter(
    (p): p is { url: string; block: string } => p.block !== null,
  )
  const spec = mergeOperationDocs(
    blocks.map(({ url, block }) => ({
      url,
      doc: parse(block) as OpenApiDocument,
    })),
  )
  const hash = await sha256Text(blocks.map((b) => b.block).join('\n'))
  return {
    specs: [spec],
    sources: [{ url: CARTESIA_API_INDEX_URL, hash }],
    outputStrategy: 'post-200',
    specRevision: hash,
  }
}

interface CartesiaVoice {
  id?: string
  name?: string
  created_at?: string
}

interface CartesiaVoiceList {
  data?: Array<CartesiaVoice>
  has_more?: boolean
  next_page?: string | null
}

async function listModels(env: ProviderSecrets): Promise<ListModelsResult> {
  const key = env.CARTESIA_API_KEY
  if (!key) {
    return { models: [], ...skippedResult('cartesia', 'CARTESIA_API_KEY') }
  }
  const headers = {
    Authorization: `Bearer ${key}`,
    'Cartesia-Version': CARTESIA_VERSION,
  }
  const models: ListModelsResult['models'] = []
  let after: string | undefined
  do {
    const url = new URL(CARTESIA_VOICES_URL)
    url.searchParams.set('limit', '100')
    if (after) url.searchParams.set('starting_after', after)
    const body = (await fetchJson(url.toString(), {
      headers,
    })) as CartesiaVoiceList
    for (const voice of body.data ?? []) {
      if (typeof voice.id !== 'string' || voice.id.length === 0) continue
      models.push({
        rawId: voice.id,
        displayName: voice.name ?? null,
        activity: 'audio',
        // Voices are the TTS catalog. STT uses a separate model id.
        modalities: normalizeMediaModalities({
          activity: 'audio',
          listingInput: ['text'],
          listingOutput: ['audio'],
        }),
        releasedAt: isoToEpochSeconds(voice.created_at),
      })
    }
    after = body.has_more && body.next_page ? body.next_page : undefined
  } while (after)
  return { models }
}

export const provider: ProviderConfig = {
  id: 'cartesia',
  displayName: 'Cartesia',
  authEnvVar: 'CARTESIA_API_KEY',
  specSourceUrl: CARTESIA_API_INDEX_URL,
  modelsEndpoint: CARTESIA_VOICES_URL,
  defaultDerivation: 'upstream-spec',
  fetchSpec,
  listModels,
  classify,
  generationEndpointId: () => 'tts/bytes',
}
