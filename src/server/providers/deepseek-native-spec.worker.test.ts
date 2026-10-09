import { env } from 'cloudflare:test'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '#/db/index.ts'
import { endpoints, providers, schemaVersions } from '#/db/schema.ts'
import { syncProvider } from '../ingest/sync.ts'
import type { ProviderConfig } from './types.ts'
import { expect, it } from 'vitest'
import {
  DEEPSEEK_CHAT_DOCS,
  decodeDeepseekOperation,
  nativeDeepseekDocument,
} from './deepseek-native-spec.ts'

it('decodes native deflate operation payloads in workerd without eval', async () => {
  const operation = await decodeDeepseekOperation(
    'api:"eJyljrEOwjAMRH8FeUYEMTLyG4ghpCcSaGMTG6Sq4t9JAgszns7npzsvpChPFKX96rjQo4xVUDQT3TvnJW0GQBS4bQJP9DqtVzTBIg+NE1aj6oi32HYXojdXQRlhibO2Y8H9AbUDD3NlFgqcDdm69iJjCr6x7qqcu6khYvJd2ixowXy+InyqCguKJWgHJh4w/qBqJeULvfr0epX6yZffbbf/PvFJfgM4KWlp"',
  )
  expect(
    nativeDeepseekDocument(operation).paths?.['/chat/completions']?.post
      ?.requestBody,
  ).toEqual(operation.requestBody)
})

it('replaces both current borrowed schema kinds with native fragments', async () => {
  const db = getDb(env)
  const id = 'deepseek-native-replacement'
  const endpointId = `${id}/chat/completions`
  await db.insert(providers).values({
    id,
    displayName: 'Native DeepSeek test',
    specSourceUrl: DEEPSEEK_CHAT_DOCS,
  })
  await db.insert(endpoints).values({
    id: endpointId,
    providerId: id,
    activity: 'chat',
    method: 'POST',
    path: '/chat/completions',
  })
  for (const kind of ['input', 'output'] as const) {
    await db.insert(schemaVersions).values({
      id: `${endpointId}:${kind}:borrowed`,
      endpointId,
      kind,
      contentHash: 'b'.repeat(64),
      schema: JSON.stringify({
        type: 'object',
        properties: { borrowed: { type: 'string' } },
      }),
      sourceUrl:
        'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml',
      sourceHash: 'c'.repeat(64),
      derivation: 'generated',
      createdAt: 1,
    })
  }
  const native = nativeDeepseekDocument({
    servers: [{ url: 'https://api.deepseek.com' }],
    method: 'post',
    path: '/chat/completions',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { messages: { type: 'array' } },
          },
        },
      },
    },
    responses: {
      '200 (No streaming)': {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { choices: { type: 'array' } },
            },
          },
        },
      },
    },
  })
  const provider: ProviderConfig = {
    id,
    displayName: 'Native DeepSeek test',
    defaultDerivation: 'generated',
    fetchSpec: async () => ({
      specs: [native],
      sources: [{ url: DEEPSEEK_CHAT_DOCS, hash: 'd'.repeat(64) }],
      outputStrategy: 'post-200',
    }),
    listModels: async () => ({ models: [] }),
    classify: (path) => (path === '/chat/completions' ? 'chat' : null),
  }
  const result = await syncProvider(
    { db, kv: env.SCHEMA_CACHE, secrets: {}, now: () => 10 },
    provider,
  )
  expect(result.versionsAdded).toBe(2)
  const current = await db
    .select()
    .from(schemaVersions)
    .where(
      and(
        eq(schemaVersions.endpointId, endpointId),
        isNull(schemaVersions.supersededAt),
      ),
    )
  expect(current).toHaveLength(2)
  expect(current.every((row) => row.sourceUrl === DEEPSEEK_CHAT_DOCS)).toBe(
    true,
  )
  expect(current.every((row) => !row.schema.includes('borrowed'))).toBe(true)
})
