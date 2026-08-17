import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '#/db/index.ts'
import type { Db } from '#/db/index.ts'
import { endpoints, models, providers, schemaVersions } from '#/db/schema.ts'
import { assembleProviderOpenApi } from './provider-openapi.ts'

const NOW = 1_781_150_000
const INPUT = {
  type: 'object',
  required: ['model'],
  properties: { model: { type: 'string' }, max_tokens: { type: 'integer' } },
}
const OUTPUT = { type: 'object', properties: { id: { type: 'string' } } }

let db: Db

beforeAll(async () => {
  db = getDb(env)
  await db
    .insert(providers)
    .values([
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        specSourceUrl: 'https://example.com/a.json',
      },
      {
        id: 'fal',
        displayName: 'FAL',
        specSourceUrl: 'https://example.com/f.json',
      },
    ])
    .onConflictDoNothing()
  await db
    .insert(endpoints)
    .values([
      {
        id: 'anthropic/v1/messages',
        providerId: 'anthropic',
        activity: 'chat',
        method: 'POST',
        path: '/v1/messages',
        description: 'Create a message',
      },
      {
        id: 'fal/fal-ai/flux/dev',
        providerId: 'fal',
        activity: 'image',
        method: 'POST',
        path: '/fal-ai/flux/dev',
      },
      {
        id: 'fal/fal-ai/other',
        providerId: 'fal',
        activity: 'image',
        method: 'POST',
        path: '/fal-ai/other',
      },
    ])
    .onConflictDoNothing()
  await db
    .insert(schemaVersions)
    .values([
      {
        id: 'anthropic/v1/messages:input',
        endpointId: 'anthropic/v1/messages',
        kind: 'input',
        contentHash: 'a'.repeat(64),
        schema: JSON.stringify(INPUT),
        createdAt: NOW,
      },
      {
        id: 'anthropic/v1/messages:output',
        endpointId: 'anthropic/v1/messages',
        kind: 'output',
        contentHash: 'b'.repeat(64),
        schema: JSON.stringify(OUTPUT),
        createdAt: NOW,
      },
      {
        id: 'fal/fal-ai/flux/dev:input',
        endpointId: 'fal/fal-ai/flux/dev',
        kind: 'input',
        contentHash: 'c'.repeat(64),
        schema: JSON.stringify({
          type: 'object',
          properties: { prompt: { type: 'string' } },
        }),
        createdAt: NOW,
      },
      {
        id: 'fal/fal-ai/flux/dev:output',
        endpointId: 'fal/fal-ai/flux/dev',
        kind: 'output',
        contentHash: 'd'.repeat(64),
        schema: JSON.stringify(OUTPUT),
        createdAt: NOW,
      },
      {
        id: 'fal/fal-ai/other:input',
        endpointId: 'fal/fal-ai/other',
        kind: 'input',
        contentHash: 'e'.repeat(64),
        schema: JSON.stringify({ type: 'object' }),
        createdAt: NOW,
      },
    ])
    .onConflictDoNothing()
  await db
    .insert(models)
    .values([
      {
        id: 'fal-fal-ai-flux-dev',
        providerId: 'fal',
        rawId: 'fal-ai/flux/dev',
        activity: 'image',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
      {
        id: 'anthropic-claude-sonnet-4-5',
        providerId: 'anthropic',
        rawId: 'claude-sonnet-4-5',
        activity: 'chat',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ])
    .onConflictDoNothing()
})

describe('assembleProviderOpenApi', () => {
  it('assembles a connectable Anthropic document', async () => {
    const result = await assembleProviderOpenApi(db, 'anthropic')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.document.openapi).toBe('3.1.0')
    const paths = result.document.paths as Record<
      string,
      { post?: { parameters?: Array<{ name: string }>; requestBody?: unknown } }
    >
    expect(paths['/v1/messages']?.post?.requestBody).toBeDefined()
    const headers = paths['/v1/messages']?.post?.parameters ?? []
    expect(headers.some((p) => p.name === 'anthropic-version')).toBe(true)
    expect((result.document.servers as Array<{ url: string }>)[0]?.url).toBe(
      'https://api.anthropic.com',
    )
    const body = paths['/v1/messages']?.post?.requestBody as
      | {
          content: {
            'application/json': {
              schema: { properties?: { model?: { enum?: Array<string> } } }
            }
          }
        }
      | undefined
    expect(
      body?.content['application/json'].schema.properties?.model?.enum,
    ).toEqual(['claude-sonnet-4-5'])
  })

  it('pins the model enum when ?model= is passed', async () => {
    const result = await assembleProviderOpenApi(db, 'anthropic', {
      model: 'claude-sonnet-4-5',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const paths = result.document.paths as Record<
      string,
      {
        post?: {
          requestBody?: {
            content: {
              'application/json': {
                schema: { properties?: { model?: { enum?: Array<string> } } }
              }
            }
          }
        }
      }
    >
    expect(
      paths['/v1/messages']?.post?.requestBody?.content['application/json']
        .schema.properties?.model?.enum,
    ).toEqual(['claude-sonnet-4-5'])
  })

  it('refuses a combined FAL spec and serves one model with sibling GET', async () => {
    const bare = await assembleProviderOpenApi(db, 'fal')
    expect(bare).toMatchObject({
      ok: false,
      status: 400,
      code: 'spec_requires_selector',
    })

    const pinned = await assembleProviderOpenApi(db, 'fal', {
      model: 'fal-ai/flux/dev',
    })
    expect(pinned.ok).toBe(true)
    if (!pinned.ok) return
    const paths = pinned.document.paths as Record<
      string,
      {
        post?: {
          responses?: { '200'?: { content?: unknown } }
        }
        get?: {
          parameters?: Array<{ name: string }>
          responses?: {
            '200'?: {
              content?: {
                'application/json': {
                  schema: { properties?: { id?: unknown } }
                }
              }
            }
          }
        }
      }
    >
    expect(paths['/fal-ai/flux/dev']?.post).toBeDefined()
    expect(
      paths['/fal-ai/flux/dev']?.post?.responses?.['200']?.content,
    ).toBeUndefined()
    const sibling = paths['/fal-ai/flux/dev/requests/{request_id}']?.get
    expect(sibling).toBeDefined()
    expect(sibling?.parameters?.some((p) => p.name === 'request_id')).toBe(true)
    expect(
      sibling?.responses?.['200']?.content?.['application/json'].schema
        .properties?.id,
    ).toBeDefined()
    expect(paths['/fal-ai/other']).toBeUndefined()

    expect(
      await assembleProviderOpenApi(db, 'fal', { activity: 'image' }),
    ).toMatchObject({
      ok: false,
      status: 400,
      code: 'spec_requires_selector',
    })
  })

  it('refuses assembly over the endpoint cap', async () => {
    await db
      .insert(providers)
      .values({
        id: 'cap-prov',
        displayName: 'Cap',
        specSourceUrl: 'https://example.com/c.json',
      })
      .onConflictDoNothing()
    const rows = Array.from({ length: 41 }, (_, i) => ({
      id: `cap-prov/e${String(i)}`,
      providerId: 'cap-prov',
      activity: 'chat' as const,
      method: 'POST',
      path: `/e${String(i)}`,
    }))
    for (let i = 0; i < rows.length; i += 10) {
      await db
        .insert(endpoints)
        .values(rows.slice(i, i + 10))
        .onConflictDoNothing()
    }
    expect(await assembleProviderOpenApi(db, 'cap-prov')).toMatchObject({
      ok: false,
      status: 400,
      code: 'spec_requires_selector',
    })
  })

  it('404s unknown provider and unknown model', async () => {
    expect(await assembleProviderOpenApi(db, 'nope')).toMatchObject({
      ok: false,
      status: 404,
      code: 'unknown_provider',
    })
    expect(
      await assembleProviderOpenApi(db, 'fal', { model: 'missing' }),
    ).toMatchObject({ ok: false, status: 404, code: 'unknown_model' })
  })
})
