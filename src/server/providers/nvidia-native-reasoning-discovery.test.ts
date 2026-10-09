import { afterEach, expect, it } from 'vitest'
import docs from './fixtures/nvidia-native-reasoning-discovery.json'
import absentBuild from './fixtures/nvidia-build-absent-page.json'
import {
  parseNvidiaInfer,
  nvidiaReasoning,
  nvidiaInferNamesModel,
  nvidiaStatedModelIds,
  NVIDIA_REFERENCE_INDEXES,
} from './nvidia-openapi.ts'
import {
  discoverNvidiaSitemap,
  NVIDIA_SITEMAP_URL,
  parseNvidiaInferSitemap,
} from './nvidia-sitemap.ts'
import { provider, NVIDIA_MODELS_URL } from './adapters/nvidia.ts'

const native = docs as Record<string, string>
const source = (slug: string) =>
  'https://docs.api.nvidia.com/nim/reference/' + slug + '-infer.md'
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
function serve(overrides: Record<string, string> = {}) {
  globalThis.fetch = async (input) => {
    const url = String(input)
    const body =
      overrides[url] ??
      native[url] ??
      (absentBuild.cards as Record<string, string>)[url] ??
      (url.startsWith('https://build.nvidia.com/') &&
      !url.endsWith('.md') &&
      (native[`${url}.md`] ||
        (absentBuild.cards as Record<string, string>)[`${url}.md`])
        ? absentBuild.html
        : undefined)
    if (
      body === undefined &&
      url.startsWith('https://build.nvidia.com/') &&
      url.endsWith('.md')
    )
      return new Response(absentBuild.html, { status: 404 })
    if (body === undefined) throw new Error('unexpected native source ' + url)
    return new Response(body)
  }
}
it('accepts native title wrappers only as model IDs and preserves schema identity mismatches', () => {
  for (const [id, slug, mode] of [
    ['google/gemma-4-31b-it', 'google-gemma-4-31b-it', 'toggle'],
    ['google/diffusiongemma-26b-a4b-it', 'diffusiongemma-26b-a4b-it', 'toggle'],
    ['meta/muse-glimmer-30b', 'meta-muse-glimmer-30b', 'effort'],
  ] as const) {
    const parsed = parseNvidiaInfer(native[source(slug)]!)!
    expect(nvidiaStatedModelIds(parsed.document)).toEqual([id])
    expect(nvidiaInferNamesModel(id, parsed.document)).toBe(true)
    expect(parsed.reasoning?.mode).toBe(mode)
    expect(parsed.reasoning?.mandatory).toBe(mode === 'toggle' ? false : null)
  }
  const muse = parseNvidiaInfer(native[source('meta-muse-glimmer-30b')]!)!
  expect(muse.reasoning?.efforts).toEqual([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'max',
  ])
  const wrong = parseNvidiaInfer(
    native[source('nvidia-nemotron-3-5-content-safety')]!,
  )!
  expect(
    nvidiaInferNamesModel('nvidia/nemotron-3.5-content-safety', wrong.document),
  ).toBe(false)
  expect(nvidiaStatedModelIds(wrong.document)).toEqual([
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  ])
})
it('does not borrow controls from model prompt protocols or request examples', () => {
  for (const slug of [
    'nvidia-deepseek-v4_1-flash',
    'poolside-laguna-xs-2-1',
    'nvidia-llama-3_1-nemotron-safety-guard-8b-v3',
  ])
    expect(parseNvidiaInfer(native[source(slug)]!)?.reasoning).toBeUndefined()
})
it('discovers native schema-owned bindings even when slugs omit or change the namespace', async () => {
  serve()
  const ids = [
    'google/gemma-4-31b-it',
    'google/diffusiongemma-26b-a4b-it',
    'meta/muse-glimmer-30b',
    'deepseek-ai/deepseek-v4.1-flash',
    'poolside/laguna-xs-2.1',
  ]
  const result = await discoverNvidiaSitemap(ids)
  expect(result.rows.map((row) => row.rawId).sort()).toEqual([...ids].sort())
  expect(result.failures.failed).toBe(0)
  expect(result.unavailable).toEqual([])
  expect(
    result.rows.find((row) => row.rawId === 'deepseek-ai/deepseek-v4.1-flash')
      ?.inferUrl,
  ).toBe(source('nvidia-deepseek-v4_1-flash').slice(0, -3))
})
it('reports a mismatched source schema instead of assigning another model data', async () => {
  serve()
  const result = await discoverNvidiaSitemap([
    'nvidia/nemotron-3.5-content-safety',
  ])
  expect(result.rows).toEqual([])
  expect(result.unavailable).toEqual(['nvidia/nemotron-3.5-content-safety'])
  expect(result.failures.failed).toBe(1)
  expect(result.failures.first[0]?.error).toContain(
    'does not identify its candidate model',
  )
})
it('refuses malformed sitemap or schema documents and surfaces source failures', async () => {
  expect(() =>
    parseNvidiaInferSitemap(
      '<urlset><loc>https://docs.api.nvidia.com/nim/reference/model-infer</loc>',
    ),
  ).toThrow('urlset')
  expect(() =>
    parseNvidiaInferSitemap(
      '<urlset><loc>https://third-party.test/model-infer</loc></urlset>',
    ),
  ).toThrow('no native infer')
  serve({ [source('google-gemma-4-31b-it')]: 'not a schema' })
  const result = await discoverNvidiaSitemap(['google/gemma-4-31b-it'])
  expect(result.rows).toEqual([])
  expect(result.failures.failed).toBe(1)
  expect(result.unavailable).toEqual(['google/gemma-4-31b-it'])
})
it('uses discovered schema facts and binding for the native production row and fetched spec', async () => {
  const listing = JSON.parse(native[NVIDIA_MODELS_URL]!) as {
    data: Array<{ id: string }>
  }
  const own = listing.data.filter((row) => row.id === 'google/gemma-4-31b-it')
  expect(own).toHaveLength(1)
  serve({
    [NVIDIA_MODELS_URL]: JSON.stringify({ ...listing, data: own }),
    ...Object.fromEntries(
      NVIDIA_REFERENCE_INDEXES.slice(1).map((url) => [
        url,
        '---\n---\n# No relevant models\n',
      ]),
    ),
  })
  const result = await provider.listModels({})
  expect(result.models[0]?.reasoning).toEqual({
    mode: 'toggle',
    mandatory: false,
  })
  expect(result.models[0]?.schemaEndpointId).toBe('google/gemma-4-31b-it')
  expect(result.models[0]?.factSources?.reasoning?.sourceUrl).toBe(
    source('google-gemma-4-31b-it'),
  )
  const fetched = await provider.fetchSpec({})
  expect(fetched.specs).toEqual([])
  expect(fetched.bundledEndpoints).toHaveLength(1)
  expect(fetched.bundledEndpoints?.[0]).toMatchObject({
    publicId: 'google/gemma-4-31b-it',
    path: '/chat/completions',
  })
})

it('reports an unreadable native discovery source for every affected model', async () => {
  serve({ [NVIDIA_SITEMAP_URL]: 'not a sitemap' })
  const result = await discoverNvidiaSitemap(['google/gemma-4-31b-it'])
  expect(result.rows).toEqual([])
  expect(result.failures.failed).toBe(1)
  expect(result.failures.first[0]?.source).toBe(NVIDIA_SITEMAP_URL)
  expect(result.unavailable).toEqual(['google/gemma-4-31b-it'])
})

it('keeps enum-only mandatory unknown and requires normative disabling meaning', () => {
  const parsed = parseNvidiaInfer(native[source('meta-muse-glimmer-30b')]!)!
  expect(nvidiaReasoning(parsed.document)?.mandatory).toBeNull()
  const text = JSON.stringify(parsed.document)
  for (const [note, expected] of [
    ['none disables reasoning.', false],
    ['none does not disable reasoning.', null],
    ['Do not assume that none disables reasoning.', null],
    ['```\nnone disables reasoning.\n```', null],
  ] as const) {
    const modified = text.replace(
      'How much reasoning the model should do before answering.',
      JSON.stringify(note).slice(1, -1) +
        ' How much reasoning the model should do before answering.',
    )
    expect(
      nvidiaReasoning(JSON.parse(modified) as typeof parsed.document)
        ?.mandatory,
    ).toBe(expected)
  }
})
it('validates singleton cache bindings on every cache hit', async () => {
  const id = 'google/gemma-4-31b-it'
  for (const value of [
    [id, 'wrong/model'],
    [id, id],
    { 0: id },
    [null],
    ['other/model'],
  ] as const) {
    serve()
    const kv = {
      get: async (key: string) =>
        key.includes('nvidia-sitemap-binding:') ? JSON.stringify(value) : null,
      put: async () => {},
    } as unknown as KVNamespace
    const result = await discoverNvidiaSitemap([id], kv)
    expect(result.rows).toEqual([])
    expect(result.failures.failed).toBe(1)
    expect(result.unavailable).toEqual([id])
  }
})
for (const malformed of [true, false])
  it(
    'reports malformed or wrong-model selected reference-index schemas visibly ' +
      malformed,
    async () => {
      const id = 'google/gemma-4-31b-it'
      const url = source('google-gemma-4-31b-it')
      const all = JSON.parse(native[NVIDIA_MODELS_URL]!) as {
        data: Array<{ id: string }>
      }
      const index =
        '---\n---\n| Model | Endpoint |\n| --- | --- |\n| [google / gemma-4-31b-it](https://docs.api.nvidia.com/nim/reference/google-gemma-4-31b-it) | [Infer](' +
        url.slice(0, -3) +
        ') |\n'
      serve({
        [NVIDIA_MODELS_URL]: JSON.stringify({
          ...all,
          data: all.data.filter((row) => row.id === id),
        }),
        [NVIDIA_REFERENCE_INDEXES[0]!]: index,
        [url]: malformed
          ? 'not a schema'
          : native[source('nvidia-nemotron-3-5-content-safety')]!,
        ...Object.fromEntries(
          NVIDIA_REFERENCE_INDEXES.slice(1).map((indexUrl) => [
            indexUrl,
            '---\n---\n# No relevant models\n',
          ]),
        ),
      })
      const result = await provider.listModels({})
      expect(result.models[0]?.capabilities).toContain('reasoning')
      expect(result.models[0]?.reasoning).toBeUndefined()
      expect(result.models[0]?.absent?.reasoning).toBe('unavailable')
      expect(result.docsFailures?.failed).toBe(1)
      expect(result.docsFailures?.first[0]?.error).toContain(
        malformed ? 'no OpenAPI' : 'identity conflict',
      )
      if (!malformed)
        expect(result.docsFailures?.first[0]?.error).toContain(
          'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
        )
      await expect(provider.fetchSpec({})).rejects.toThrow(
        'parsed 0 generation specs',
      )
    },
  )

it('native absent Build pages preserve independent owned contracts without consuming failure budget', async () => {
  const listing = JSON.parse(native[NVIDIA_MODELS_URL]!) as {
    data: Array<{ id: string }>
  }
  const ids = [
    'google/gemma-4-31b-it',
    'google/diffusiongemma-26b-a4b-it',
    'meta/muse-glimmer-30b',
    'deepseek-ai/deepseek-v4.1-flash',
    'poolside/laguna-xs-2.1',
  ]
  const data = listing.data.filter((row) => ids.includes(row.id))
  expect(data).toHaveLength(ids.length)
  serve({
    [NVIDIA_MODELS_URL]: JSON.stringify({ ...listing, data }),
    ...Object.fromEntries(
      NVIDIA_REFERENCE_INDEXES.slice(1).map((url) => [
        url,
        '---\n---\n# No relevant models\n',
      ]),
    ),
  })
  const result = await provider.listModels({})
  expect(result.docsFailures).toEqual({ failed: 0, skipped: 0, first: [] })
  expect(result.models).toHaveLength(ids.length)
  expect(result.models.every((row) => row.schemaEndpointId === row.rawId)).toBe(
    true,
  )
  expect(
    result.models.find((row) => row.rawId === 'google/gemma-4-31b-it')
      ?.reasoning?.mode,
  ).toBe('toggle')
  expect(
    result.models.find((row) => row.rawId === 'meta/muse-glimmer-30b')
      ?.reasoning?.mode,
  ).toBe('effort')
})
