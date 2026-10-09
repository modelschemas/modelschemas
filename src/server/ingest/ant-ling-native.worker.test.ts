import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { afterEach, expect, it, vi } from 'vitest'
import { getDb } from '../../db/index.ts'
import { models } from '../../db/schema.ts'
import { provider } from '../providers/adapters/ant-ling.ts'
import fixtures from '../providers/fixtures/ant-ling-docs.json'
import { pollProviderModels } from './poll-models.ts'

afterEach(() => vi.unstubAllGlobals())

it('ingests native Ant Ling rows and prices using real Worker KV and D1', async () => {
  const BROWSER = {
    quickAction: async (action: string, options: { url?: string }) => {
      if (action !== 'content' || !options.url)
        throw new Error('unexpected browser action')
      const url = options.url
      const body = (fixtures as Record<string, string>)[url]
      if (body === undefined) throw new Error(`unexpected native source ${url}`)
      return Response.json({
        success: true,
        result: body,
        meta: { status: 200, finalUrl: url, title: 'native fixture' },
      })
    },
  } as unknown as Pick<BrowserRun, 'quickAction'>
  vi.stubGlobal('fetch', async () => {
    throw new Error('native browser reader must not use direct fetch')
  })
  const db = getDb(env)
  const outcome = await pollProviderModels(
    { db, kv: env.SCHEMA_CACHE, secrets: { BROWSER } },
    provider,
  )
  expect(outcome.modelsSeen).toBe(8)
  expect(outcome.added).toBe(8)
  expect(outcome.failures).toBe(0)
  const rows = await db
    .select()
    .from(models)
    .where(eq(models.providerId, provider.id))
  for (const rawId of ['Ling-2.6-1T', 'Ling-2.6-flash', 'Ring-2.6-1T']) {
    const row = rows.find((model) => model.rawId === rawId)
    expect(row?.activity).toBe('chat')
    expect(row?.pricing).not.toBeNull()
    expect(row?.maxOutput).toBeNull()
  }
})
