/** Extract the native operation JSON embedded in DeepSeek's own API docs. */
import { PROVENANCE_MARKER, sha256Text } from './types.ts'
import type { OpenApiDocument, SpecFetchResult } from './types.ts'

export const DEEPSEEK_CHAT_DOCS =
  'https://api-docs.deepseek.com/api/create-chat-completion/'
const DOCS_ORIGIN = 'https://api-docs.deepseek.com'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function ownedDeepseekAsset(value: string): string {
  const url = new URL(value, DOCS_ORIGIN)
  if (
    url.origin !== DOCS_ORIGIN ||
    !/^\/assets\/js\/[\w.~+-]+\.js$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error(`deepseek: docs asset is not owned: ${url.href}`)
  return url.href
}

/** Only parse asset names and numeric webpack mappings; never evaluate JavaScript. */
export function discoverDeepseekChunk(main: string, runtime: string): string {
  const key = main.match(
    /([a-f0-9]+):\[\(\)=>Promise\.all\(\[[^\]]+\]\)\.then\([A-Za-z_$][\w$]*\.bind\([A-Za-z_$][\w$]*,\d+\)\),"@site\/docs\/api\/create-chat-completion\.api\.mdx"/,
  )?.[1]
  if (!key) throw new Error('deepseek: native API page module not found')
  const pairs = [...runtime.matchAll(/\b(\d+(?:e\d+)?):"([\w-]+)"/g)]
  const id = pairs.find((pair) => pair[2] === key)?.[1]
  if (!id) throw new Error('deepseek: native API chunk mapping not found')
  const values = pairs.filter((pair) => pair[1] === id).map((pair) => pair[2])
  if (
    values.length !== 2 ||
    values[0] !== key ||
    !/^[a-f0-9]+$/.test(values[1] ?? '')
  )
    throw new Error('deepseek: native API chunk hash mapping unreadable')
  return ownedDeepseekAsset(`/assets/js/${key}.${values[1]}.js`)
}

export async function decodeDeepseekOperation(
  chunk: string,
): Promise<Record<string, unknown>> {
  const entries = [
    ...new Set(
      [...chunk.matchAll(/\bapi:"([A-Za-z0-9+/=]+)"/g)].map(
        (match) => match[1],
      ),
    ),
  ]
  if (entries.length !== 1 || !entries[0])
    throw new Error('deepseek: native operation payload not found uniquely')
  const binary = atob(entries[0])
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  const payload: unknown = await new Response(stream).json()
  if (!record(payload))
    throw new Error('deepseek: native operation is not an object')
  return payload
}

export function nativeDeepseekDocument(
  payload: Record<string, unknown>,
): OpenApiDocument {
  if (
    payload.method !== 'post' ||
    payload.path !== '/chat/completions' ||
    !record(payload.requestBody) ||
    !record(payload.responses)
  )
    throw new Error('deepseek: native chat operation contract changed')
  if (
    !Array.isArray(payload.servers) ||
    payload.servers.length === 0 ||
    !payload.servers.every(
      (server) => record(server) && server.url === 'https://api.deepseek.com',
    )
  )
    throw new Error('deepseek: native API server is not owned')
  const content = payload.requestBody.content
  const media = record(content) ? content['application/json'] : null
  if (
    !record(media) ||
    !record(media.schema) ||
    Object.keys(media.schema).length === 0
  )
    throw new Error('deepseek: native JSON request schema unpublished')
  const responses: Record<string, unknown> = {}
  const streaming: Record<string, unknown> = {}
  for (const [label, response] of Object.entries(payload.responses)) {
    const code = label.match(/^(\d{3})(?: \(No streaming\))?$/)?.[1]
    if (code) {
      if (code in responses)
        throw new Error('deepseek: ambiguous native response status')
      responses[code] = response
    } else if (/^\d{3} \(Streaming\)$/.test(label)) {
      streaming[label] = response
    } else
      throw new Error(`deepseek: unreadable native response status ${label}`)
  }
  if (!('200' in responses))
    throw new Error(
      'deepseek: native non-streaming success response unpublished',
    )
  const metadata = new Set([
    'method',
    'path',
    'servers',
    'securitySchemes',
    'info',
    'postman',
    'jsonRequestBodyExample',
  ])
  const operation = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !metadata.has(key)),
  )
  return {
    ...(record(payload.info) ? { info: payload.info } : {}),
    servers: payload.servers as Array<Record<string, unknown>>,
    ...(record(payload.securitySchemes)
      ? { components: { securitySchemes: payload.securitySchemes } }
      : {}),
    paths: {
      '/chat/completions': {
        post: {
          ...operation,
          responses,
          ...(Object.keys(streaming).length > 0
            ? { 'x-modelschemas-streaming-responses': streaming }
            : {}),
          [PROVENANCE_MARKER]: { derivation: 'generated' },
          'x-modelschemas-deepseek-native': true,
        },
      },
    },
  }
}

async function textAt(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok)
    throw new Error(`deepseek: native docs ${response.status} at ${url}`)
  if (response.url && new URL(response.url).origin !== DOCS_ORIGIN)
    throw new Error('deepseek: native docs redirected to an unowned host')
  return response.text()
}

export async function fetchNativeDeepseekSpec(): Promise<SpecFetchResult> {
  const page = await textAt(DEEPSEEK_CHAT_DOCS)
  const scripts = [...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(
    (match) => ownedDeepseekAsset(match[1] ?? ''),
  )
  const main = scripts.find((url) => /\/main\.[\w-]+\.js$/.test(url))
  const runtime = scripts.find((url) => /\/runtime~main\.[\w-]+\.js$/.test(url))
  if (!main || !runtime)
    throw new Error('deepseek: native docs script assets not found')
  const [mainText, runtimeText] = await Promise.all([
    textAt(main),
    textAt(runtime),
  ])
  const url = discoverDeepseekChunk(mainText, runtimeText)
  const chunk = await textAt(url)
  const payload = await decodeDeepseekOperation(chunk)
  const spec = nativeDeepseekDocument(payload)
  const hash = await sha256Text(chunk)
  return {
    specs: [spec],
    sources: [{ url, hash }],
    outputStrategy: 'post-200',
    specRevision: hash,
  }
}
