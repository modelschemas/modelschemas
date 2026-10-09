import { expect, it, afterEach, vi } from 'vitest'
import native from './fixtures/nvidia-native-build-spec.json'
import reference from './fixtures/nvidia-native-reasoning-discovery.json'
import { NVIDIA_REFERENCE_INDEXES, nvidiaWireFacts } from './nvidia-openapi.ts'
import {
  parseNvidiaBuildSpec,
  validateNvidiaBuildFacts,
} from './nvidia-build-spec.ts'

import { provider, NVIDIA_MODELS_URL } from './adapters/nvidia.ts'
import { sha256Text } from './types.ts'

const rawId = 'nvidia/nemotron-3.5-content-safety'
const html = native[rawId].html
it('reads the actual hosted Build spec independently of the incorrect ReadMe Nano schema', () => {
  const facts = parseNvidiaBuildSpec(html, rawId)
  expect(facts?.document.info?.title).toBe('NVIDIA NIM API for ' + rawId)
  expect(facts?.reasoning).toEqual({ mode: 'toggle', mandatory: false })
  expect(facts?.maxOutput).toBe(4096)
  expect(facts?.activity).toBe('chat')
  expect(facts?.document.servers).toContainEqual({
    url: 'https://integrate.api.nvidia.com/v1',
  })
  expect(Object.keys(facts?.document.paths ?? {})).toContain(
    '/chat/completions',
  )
})
it('binds actual native request selectors independently of API display titles', () => {
  for (const id of [
    'nvidia/llama-3.1-nemotron-safety-guard-8b-v3',
    'nvidia/nemotron-parse-2.0',
  ] as const) {
    expect(
      parseNvidiaBuildSpec(native[id].html, id)?.document.info?.title,
    ).not.toContain(id)
  }
})
it('fails on malformed published primary schema data', () => {
  expect(() =>
    parseNvidiaBuildSpec(
      html.replaceAll('openAPISpec', 'openAPISpecBROKEN'),
      rawId,
    ),
  ).toThrow('marker is unreadable')
  expect(() => parseNvidiaBuildSpec('<html>Challenge</html>', rawId)).toThrow(
    'no native Flight',
  )
  expect(parseNvidiaBuildSpec('NEXT_HTTP_ERROR_FALLBACK;404', rawId)).toBeNull()
  expect(() => parseNvidiaBuildSpec(html, 'nvidia/another-model')).toThrow(
    'identity conflict',
  )
})
it('only a healthy native page without a schema can report absence', () => {
  expect(
    parseNvidiaBuildSpec(
      '<script>self.__next_f.push([1,"1:{\\"model\\":\\"nvidia/example\\"}"])</script>',
      'nvidia/example',
    ),
  ).toBeNull()
})
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})
function ownSources(page: string) {
  const requested: string[] = []
  const url = native[rawId].sourceUrl
  globalThis.fetch = async (input) => {
    const source = String(input)
    requested.push(source)
    if (source === NVIDIA_MODELS_URL)
      return new Response(JSON.stringify({ data: [{ id: rawId }] }))
    if (source === url + '.md') return new Response(native[rawId].markdown)
    if (source === url) return new Response(page)
    if ((reference as Record<string, string>)[source])
      return new Response((reference as Record<string, string>)[source])
    if (NVIDIA_REFERENCE_INDEXES.includes(source))
      return new Response('---\n---\n# No relevant models\n')
    throw new Error('Unselected secondary source requested: ' + source)
  }
  return requested
}
it('syncs the native primary before secondary discovery and keeps real path separate from model identity', async () => {
  const requested = ownSources(html)
  const rows = await provider.listModels({})
  expect(requested).toContain(native[rawId].sourceUrl)
  expect(requested).toContain(
    'https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-content-safety-infer.md',
  )
  const model = rows.models[0]
  expect(rows.docsFailures).toBeUndefined()
  expect(model?.reasoning).toEqual({ mode: 'toggle', mandatory: false })
  expect(model?.capabilities).toContain('reasoning')
  expect(model?.factSources?.reasoning).toMatchObject({
    sourceUrl: native[rawId].sourceUrl,
    sourceHash: await sha256Text(html),
    path: 'chat_template_kwargs.enable_thinking',
  })
  expect(model?.factSources?.schemaEndpointId?.sourceUrl).toBe(
    native[rawId].sourceUrl,
  )
  const synced = await provider.fetchSpec({})
  expect(synced.specs).toEqual([])
  expect(synced.bundledEndpoints).toHaveLength(1)
  const endpoint = synced.bundledEndpoints?.[0]
  expect(endpoint).toMatchObject({
    publicId: rawId,
    path: '/chat/completions',
    source: { url: native[rawId].sourceUrl, hash: await sha256Text(html) },
  })
  expect(endpoint?.input).toBeDefined()
  expect(endpoint?.output).toBeDefined()
  expect(provider.specGrain).toBe('model')
  expect(
    synced.warnings?.some((warning) =>
      warning.includes('rejected competing reference identity'),
    ),
  ).toBe(true)
})
it('never recovers an erroneous primary with another provider body', async () => {
  const requested = ownSources(
    html.replaceAll(
      'nvidia/nemotron-3.5-content-safety',
      'nvidia/incorrect-model',
    ),
  )
  const rows = await provider.listModels({})
  expect(rows.docsFailures?.failed).toBe(1)
  expect(rows.docsFailures?.first[0]?.source).toBe(native[rawId].sourceUrl)
  expect(rows.docsFailures?.first[0]?.error).toContain('identity conflict')
  expect(rows.models[0]?.reasoning).toBeUndefined()
  expect(rows.models[0]?.absent?.reasoning).toBe('unavailable')
  await expect(provider.fetchSpec({})).rejects.toThrow('identity conflict')
  expect(
    requested.filter((url) => url === native[rawId].sourceUrl),
  ).toHaveLength(2)
})

it('revalidates cached primary identity and derives controls from its document', () => {
  const facts = parseNvidiaBuildSpec(html, rawId)
  if (!facts) throw new Error('Missing native fixture contract')
  expect(
    validateNvidiaBuildFacts(
      {
        ...facts,
        reasoning: { mode: 'effort', mandatory: true, efforts: ['invented'] },
      },
      rawId,
    ).reasoning,
  ).toEqual({ mode: 'toggle', mandatory: false })
  expect(() =>
    validateNvidiaBuildFacts(facts, 'nvidia/unrelated-model'),
  ).toThrow('identity conflict')
})

it('reads published native JSON even when its response examples contain Markdown fences', () => {
  const id = 'microsoft/phi-3-vision-128k-instruct'
  const facts = parseNvidiaBuildSpec(native[id].html, id)
  expect(facts?.document.info?.title).toBe('NVIDIA NIM API for ' + id)
  expect(
    facts?.document.paths?.['/vlm/microsoft/phi-3-vision-128k-instruct']?.post,
  ).toBeDefined()
  expect(facts?.activity).toBeNull()
})

it('records local native identity failures without charging successful fetch time to the network failure budget', async () => {
  ownSources(html.replaceAll(rawId, 'nvidia/unrelated-model'))
  const fetchSource = globalThis.fetch
  let now = 100_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  globalThis.fetch = async (...args) => {
    if (String(args[0]) === native[rawId].sourceUrl) now += 20_000
    return fetchSource(...args)
  }
  const listing = await provider.listModels({})
  expect(listing.docsFailures?.failed).toBe(1)
  expect(listing.docsFailures?.skipped).toBe(0)
  expect(listing.docsFailures?.first[0]?.elapsedMs).toBe(0)
  expect(listing.docsFailures?.first[0]?.error).toContain('identity conflict')
})

it('never caches a malformed primary and rejects cached wrong identities without requesting secondary sources', async () => {
  const values = new Map<string, string>()
  const kv = {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value)
    },
  } as unknown as KVNamespace
  const key = 'nvidia-build-contract:v1:' + native[rawId].sourceUrl
  ownSources(html.replaceAll(rawId, 'nvidia/unrelated-model'))
  const invalid = await provider.listModels({}, kv)
  expect(invalid.docsFailures?.failed).toBe(1)
  expect(values.has(key)).toBe(false)
  ownSources(html)
  expect((await provider.listModels({}, kv)).docsFailures).toBeUndefined()
  expect(values.has(key)).toBe(true)
  const contract = values.get(key)
  if (!contract) throw new Error('Missing healthy native cached contract')
  values.set(key, contract.replaceAll(rawId, 'nvidia/unrelated-model'))
  const requested = ownSources(html)
  const badCache = await provider.listModels({}, kv)
  expect(badCache.docsFailures?.first[0]?.error).toContain('identity conflict')
  expect(requested).not.toContain(native[rawId].sourceUrl)
})

it('keeps an exact healthy ReadMe contract primary when the competing Build body omits its native thinking control', async () => {
  const id = 'google/gemma-4-31b-it'
  expect(parseNvidiaBuildSpec(native[id].html, id)?.reasoning).toBeUndefined()
  const requested: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requested.push(url)
    if (url === NVIDIA_MODELS_URL) return Response.json({ data: [{ id }] })
    if (url === native[id].sourceUrl) return new Response(native[id].html)
    const body = (reference as Record<string, string>)[url]
    if (body) return new Response(body)
    if (NVIDIA_REFERENCE_INDEXES.includes(url))
      return new Response('---\n---\n# No relevant models\n')
    throw new Error('Unexpected native source ' + url)
  }
  const result = await provider.listModels({})
  expect(result.docsFailures).toBeUndefined()
  expect(result.models[0]?.reasoning).toEqual({
    mode: 'toggle',
    mandatory: false,
  })
  expect(result.models[0]?.factSources?.reasoning?.sourceUrl).toBe(
    'https://docs.api.nvidia.com/nim/reference/google-gemma-4-31b-it-infer.md',
  )
  expect(requested).not.toContain(native[id].sourceUrl)
})

it('never uses a healthy Build body to recover a ReadMe network or malformed-content error', async () => {
  for (const bad of [
    new Response('Unavailable', { status: 503 }),
    new Response('not a provider schema'),
  ]) {
    const requested = ownSources(html)
    const nativeFetch = globalThis.fetch
    globalThis.fetch = async (...args) =>
      String(args[0]) ===
      'https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-content-safety-infer.md'
        ? bad
        : nativeFetch(...args)
    const result = await provider.listModels({})
    expect(result.docsFailures?.failed).toBe(1)
    expect(result.models[0]?.absent?.reasoning).toBe('unavailable')
    expect(result.models[0]?.schemaEndpointId).toBeUndefined()
    expect(requested).not.toContain(native[rawId].sourceUrl)
  }
})

it('never converts failed complete or partial ReadMe index discovery into unpublished-source Build selection', async () => {
  for (const allFailed of [true, false]) {
    const requested = ownSources(html)
    const ownFetch = globalThis.fetch
    globalThis.fetch = async (...args) => {
      const url = String(args[0])
      if (NVIDIA_REFERENCE_INDEXES.includes(url)) {
        if (allFailed || url === NVIDIA_REFERENCE_INDEXES[0])
          return new Response('unavailable', { status: 503 })
        return new Response('---\n---\n# No relevant models\n')
      }
      if (url === 'https://docs.api.nvidia.com/sitemap.xml')
        return new Response(
          '<urlset><url><loc>https://docs.api.nvidia.com/nim/reference/google-gemma-4-31b-it-infer</loc></url></urlset>',
        )
      return ownFetch(...args)
    }
    const result = await provider.listModels({})
    expect(result.docsFailures?.failed).toBeGreaterThan(0)
    expect(result.models[0]?.absent?.reasoning).toBe('unavailable')
    expect(result.models[0]?.schemaEndpointId).toBeUndefined()
    expect(requested).not.toContain(native[rawId].sourceUrl)
  }
})

it('retains native explicit capability negatives and surfaces a contradictory selected schema', async () => {
  const requested = ownSources(html)
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async (...args) =>
    String(args[0]) === native[rawId].sourceUrl + '.md'
      ? new Response(
          native[rawId].markdown.replace(
            '**Reasoning:** Supported',
            '**Reasoning:** Not supported',
          ),
        )
      : nativeFetch(...args)
  const result = await provider.listModels({})
  expect(result.docsFailures?.first[0]?.error).toContain(
    'explicitly rejects reasoning',
  )
  expect(result.models[0]?.unsupportedCapabilities).toContain('reasoning')
  expect(
    result.models[0]?.factSources?.capabilities?.reasoning?.sourceUrl,
  ).toBe(native[rawId].sourceUrl)
  expect(
    result.models[0]?.factSources?.capabilities?.reasoning?.sourceHash,
  ).toBe(
    await sha256Text(
      native[rawId].markdown.replace(
        '**Reasoning:** Supported',
        '**Reasoning:** Not supported',
      ),
    ),
  )
  expect(result.models[0]?.capabilities).not.toContain('reasoning')
  expect(result.models[0]?.requestMap).toBeNull()
  expect(result.models[0]?.schemaEndpointId).toBeUndefined()
  expect(requested).toContain(native[rawId].sourceUrl)
})

it('does not turn an absent capability label into an unsupported fact', async () => {
  ownSources(html)
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async (...args) =>
    String(args[0]) === native[rawId].sourceUrl + '.md'
      ? new Response(
          native[rawId].markdown.replace('- **Reasoning:** Supported\n', ''),
        )
      : nativeFetch(...args)
  const result = await provider.listModels({})
  expect(result.docsFailures).toBeUndefined()
  expect(result.models[0]?.unsupportedCapabilities).not.toContain('reasoning')
  expect(result.models[0]?.capabilities).toContain('reasoning')
})

it('derives wire fields from the exact native request members and preserves unknown leaves', async () => {
  ownSources(html)
  const model = (await provider.listModels({})).models[0]
  expect(model?.requestMap?.maxTokensField).toBe('max_tokens')
  expect(model?.requestMap?.thinking).toEqual({
    on: { chat_template_kwargs: { enable_thinking: true } },
    off: { chat_template_kwargs: { enable_thinking: false } },
    levels: null,
  })
  expect(model?.requestMap?.store).toBeNull()
  expect(model?.factSources?.requestMapFields?.maxTokensField?.sourceUrl).toBe(
    native[rawId].sourceUrl,
  )
  expect(model?.factSources?.requestMapFields?.thinking?.sourceHash).toBe(
    await sha256Text(html),
  )
})

it('responds to native role-enum and token-member changes without static per-provider flags', () => {
  const facts = parseNvidiaBuildSpec(html, rawId)
  if (!facts) throw new Error('Missing native fixture')
  const doc = structuredClone(facts.document)
  expect(nvidiaWireFacts(doc).fields.developerRole).toBe(false)
  const role = doc.components?.schemas?.Role
  if (
    !role ||
    typeof role !== 'object' ||
    Array.isArray(role) ||
    !('enum' in role)
  )
    throw new Error('Missing native role enum')
  const nativeRoles: unknown = role.enum
  role.enum = [
    ...(Array.isArray(nativeRoles) ? (nativeRoles as unknown[]) : []),
    'developer',
  ]
  expect(nvidiaWireFacts(doc).fields.developerRole).toBe(true)
  delete role.enum
  expect(nvidiaWireFacts(doc).fields.developerRole).toBeUndefined()
  const request = doc.components?.schemas?.NIMLLMChatCompletionRequest
  if (
    !request ||
    typeof request !== 'object' ||
    !('properties' in request) ||
    !request.properties ||
    typeof request.properties !== 'object' ||
    Array.isArray(request.properties)
  )
    throw new Error('Missing native request properties')
  const props = request.properties as Record<string, unknown>
  props.max_completion_tokens = props.max_tokens
  delete props.max_tokens
  expect(nvidiaWireFacts(doc).fields.maxTokensField).toBe(
    'max_completion_tokens',
  )
  delete props.max_completion_tokens
  expect(nvidiaWireFacts(doc).fields.maxTokensField).toBeUndefined()
})
