/**
 * Agent Platform discovery document → the publisher-model methods
 * (issue #203). The v1 document describes the whole platform. Training
 * jobs, deployed endpoints, and partner rawPredict stay out of this spec.
 */
import { discoveryToOpenApi } from './gemini.ts'
import type { DiscoveryDoc } from './gemini.ts'
import type { OpenApiDocument } from './types.ts'

export const VERTEX_DISCOVERY_URL =
  'https://aiplatform.googleapis.com/$discovery/rest?version=v1'

const VERBS = new Set([
  'generateContent',
  'streamGenerateContent',
  'countTokens',
  'embedContent',
  'predict',
  'predictLongRunning',
  'fetchPredictOperation',
])

interface DiscoveryMethod {
  id?: string
  path?: string
  flatPath?: string
  [key: string]: unknown
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>
  resources?: Record<string, DiscoveryResource>
}

function keepMethod(method: DiscoveryMethod): boolean {
  const id = method.id
  if (!id?.includes('.publishers.models.')) return false
  const verb = id.slice(id.lastIndexOf('.') + 1)
  if (!VERBS.has(verb)) return false
  // The short `/v1/publishers/...` aliases repeat the same verbs.
  const path = method.flatPath ?? method.path ?? ''
  return path.includes('projects/')
}

function pruneResources(
  resources: Record<string, DiscoveryResource> | undefined,
): Record<string, DiscoveryResource> | undefined {
  if (!resources) return undefined
  const out: Record<string, DiscoveryResource> = {}
  for (const [name, resource] of Object.entries(resources)) {
    const methods = Object.fromEntries(
      Object.entries(resource.methods ?? {}).filter(([, method]) =>
        keepMethod(method),
      ),
    )
    const nested = pruneResources(resource.resources)
    if (Object.keys(methods).length === 0 && !nested) continue
    out[name] = {
      ...(Object.keys(methods).length > 0 ? { methods } : {}),
      ...(nested ? { resources: nested } : {}),
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function keptMethods(
  resources: Record<string, DiscoveryResource> | undefined,
): Array<DiscoveryMethod> {
  if (!resources) return []
  const out: Array<DiscoveryMethod> = []
  for (const resource of Object.values(resources)) {
    out.push(...Object.values(resource.methods ?? {}))
    out.push(...keptMethods(resource.resources))
  }
  return out
}

/** Schemas reachable from the kept methods. A dangling `$ref` throws. */
function schemaClosure(
  schemas: NonNullable<DiscoveryDoc['schemas']>,
  roots: Array<unknown>,
): NonNullable<DiscoveryDoc['schemas']> {
  const want = new Set<string>()
  const seen = new Set<unknown>()
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const record = node as Record<string, unknown>
    const ref = record.$ref
    if (typeof ref === 'string' && !want.has(ref)) {
      want.add(ref)
      const next = schemas[ref]
      if (!next) throw new Error(`vertex discovery: missing schema ${ref}`)
      walk(next)
    }
    for (const value of Object.values(record)) walk(value)
  }
  for (const root of roots) walk(root)
  return Object.fromEntries(
    [...want].flatMap((name) => {
      const schema = schemas[name]
      return schema ? [[name, schema]] : []
    }),
  )
}

/**
 * Discovery doc reduced to publisher-model generation methods and the
 * schemas those methods reference.
 */
export function publisherModelDiscovery(doc: DiscoveryDoc): DiscoveryDoc {
  const resources = pruneResources(
    doc.resources as Record<string, DiscoveryResource> | undefined,
  )
  const methods = keptMethods(resources)
  if (methods.length === 0) {
    throw new Error('vertex discovery: no publisher model methods')
  }
  return {
    ...doc,
    resources: resources as DiscoveryDoc['resources'],
    schemas: schemaClosure(doc.schemas ?? {}, methods),
  }
}

export function vertexOpenApi(doc: DiscoveryDoc): OpenApiDocument {
  return discoveryToOpenApi(publisherModelDiscovery(doc))
}
