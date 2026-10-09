import { extractEndpointSchemas } from '../ingest/bundle.ts'
import type { BundledEndpoint, SpecSource } from './types.ts'

/** Hosted OpenAPI published in NVIDIA Build's own React Flight data. */
import {
  nvidiaInferNamesModel,
  nvidiaStatedModelIds,
  nvidiaFactsFromDocument,
} from './nvidia-openapi.ts'
import type { NvidiaInferFacts } from './nvidia-openapi.ts'

/** Read a JSON object without evaluating any page script. */
function jsonObject(text: string, offset: number): unknown {
  let start = offset
  while (/\s/.test(text[start] ?? '') && start < text.length) start++
  if (text[start] !== '{')
    throw new Error('nvidia Build: openAPISpec is not an object')
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0)
      return JSON.parse(text.slice(start, index + 1)) as unknown
  }
  throw new Error('nvidia Build: unterminated openAPISpec')
}

export function parseNvidiaBuildSpec(
  html: string,
  rawId: string,
): NvidiaInferFacts | null {
  if (html.includes('NEXT_HTTP_ERROR_FALLBACK;404')) return null
  const chunks = [
    ...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g),
  ].map((match) => {
    const value: unknown = JSON.parse(match[1]!)
    if (typeof value !== 'string')
      throw new Error('nvidia Build: unreadable Flight string')
    return value
  })
  if (!chunks.length)
    throw new Error('nvidia Build: page contains no native Flight data')
  const flight = chunks.join('')
  const documents = [...flight.matchAll(/"openAPISpec"\s*:/g)].map((match) =>
    jsonObject(flight, match.index + match[0].length),
  )
  if (!documents.length) {
    if (html.includes('openAPISpec'))
      throw new Error('nvidia Build: published schema marker is unreadable')
    return null
  }
  const unique = new Set(documents.map((doc) => JSON.stringify(doc)))
  if (unique.size !== 1)
    throw new Error('nvidia Build: conflicting published OpenAPI documents')
  const facts = nvidiaFactsFromDocument(documents[0])
  if (!facts)
    throw new Error('nvidia Build: published OpenAPI document is unreadable')
  return validateNvidiaBuildFacts(facts, rawId)
}

/** Recheck exact native identity and derive facts again on cached contracts. */
export function validateNvidiaBuildFacts(
  facts: NvidiaInferFacts,
  rawId: string,
): NvidiaInferFacts {
  const parsed = nvidiaFactsFromDocument(facts.document)
  if (!parsed)
    throw new Error('nvidia Build: cached published document is unreadable')
  const stated = nvidiaStatedModelIds(parsed.document)
  if (stated.length !== 1 || !nvidiaInferNamesModel(rawId, parsed.document))
    throw new Error(
      `nvidia Build: schema identity conflict: expected ${rawId}; stated ${stated.join(', ')}`,
    )
  return parsed
}

/** Keep the native wire path; rawId is only a logical per-model presentation ID. */
export function nvidiaOwnedEndpoint(
  rawId: string,
  facts: NvidiaInferFacts,
  source: SpecSource,
): { endpoint: BundledEndpoint; warnings: string[] } | null {
  if (!facts.activity) return null
  const operation = Object.entries(facts.document.paths ?? {}).find(
    ([path, item]) =>
      item.post &&
      (path.includes('chat/completions') ||
        path.includes('/embeddings') ||
        /(^|\/)completions$/.test(path)),
  )
  if (!operation) return null
  const [path, item] = operation
  const schemas = extractEndpointSchemas(facts.document, path, 'post-200')
  return {
    endpoint: {
      publicId: rawId,
      path,
      activity: facts.activity,
      description:
        typeof item.post?.description === 'string'
          ? item.post.description
          : typeof item.post?.summary === 'string'
            ? item.post.summary
            : null,
      source,
      derivation: 'upstream-spec',
      ...(schemas.input ? { input: schemas.input } : {}),
      ...(schemas.output ? { output: schemas.output } : {}),
    },
    warnings: schemas.warnings,
  }
}
