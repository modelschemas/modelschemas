import { env } from 'cloudflare:test'
import { expect, it, vi } from 'vitest'
import { getDb } from '../../db/index.ts'
import { providers } from '../../db/schema.ts'
import { provider, NVIDIA_MODELS_URL } from '../providers/adapters/nvidia.ts'
import { NVIDIA_REFERENCE_INDEXES } from '../providers/nvidia-openapi.ts'
import native from '../providers/fixtures/nvidia-native-build-spec.json'
import reference from '../providers/fixtures/nvidia-native-reasoning-discovery.json'
import { recordDocsFailing, readDocsFailing } from './docs-failing.ts'
import { pollProviderModels } from './poll-models.ts'

it('clears the previous NVIDIA docs outage after a healthy native adapter poll', async () => {
  const rawId = 'nvidia/nemotron-3.5-content-safety'
  const own = native[rawId]
  const db = getDb(env)
  const specSourceUrl = provider.specSourceUrl
  if (!specSourceUrl)
    throw new Error('Native NVIDIA provider source is missing')
  await db.insert(providers).values({
    id: provider.id,
    displayName: provider.displayName,
    specSourceUrl,
  })
  await recordDocsFailing(
    db,
    provider.id,
    {
      failed: 3,
      skipped: 0,
      first: [
        {
          source: own.sourceUrl,
          error: 'previous native source outage',
          elapsedMs: 1,
        },
      ],
    },
    1781150000,
  )
  expect(await readDocsFailing(db, provider.id)).toMatchObject({
    failed: 3,
    polls: 1,
  })
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === NVIDIA_MODELS_URL)
      return Response.json({ data: [{ id: rawId }] })
    if (url === own.sourceUrl + '.md') return new Response(own.markdown)
    if (url === own.sourceUrl) return new Response(own.html)
    const source = (reference as Record<string, string>)[url]
    if (source !== undefined) return new Response(source)
    if (NVIDIA_REFERENCE_INDEXES.includes(url))
      return new Response('---\n---\n# No relevant models\n')
    throw new Error('Unexpected native source request: ' + url)
  })
  try {
    const outcome = await pollProviderModels(
      { db, kv: env.SCHEMA_CACHE, secrets: {}, now: () => 1781150060 },
      provider,
    )
    expect(outcome.modelsSeen).toBe(1)
    expect(outcome.failures).toBe(0)
    expect(outcome.docsFailures).toBeUndefined()
    expect(outcome.docsFailing).toBeUndefined()
    expect(await readDocsFailing(db, provider.id)).toBeNull()
  } finally {
    vi.unstubAllGlobals()
  }
})
