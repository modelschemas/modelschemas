import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'

import { getDb } from './index.ts'
import {
  changes,
  endpoints,
  models,
  providers,
  schemaVersions,
} from './schema.ts'

const NOW = 1_781_150_000

describe('core domain tables (migrated D1)', () => {
  it('inserts and queries a provider with related rows across all five tables', async () => {
    const db = getDb(env)

    await db.insert(providers).values({
      id: 'anthropic',
      displayName: 'Anthropic',
      specSourceUrl: 'https://example.com/spec.yml',
      modelsEndpoint: 'https://api.anthropic.com/v1/models',
      authEnvVar: 'ANTHROPIC_API_KEY',
    })

    await db.insert(models).values({
      id: 'anthropic-claude-fable-5',
      providerId: 'anthropic',
      rawId: 'claude-fable-5',
      activity: 'chat',
      displayName: 'Claude Fable 5',
      contextWindow: 200_000,
      modalities: { input: ['text', 'image'], output: ['text'] },
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    })

    await db.insert(endpoints).values({
      id: 'anthropic-messages',
      providerId: 'anthropic',
      activity: 'chat',
      method: 'POST',
      path: '/v1/messages',
    })

    await db.insert(schemaVersions).values({
      id: 'anthropic-messages-input-1',
      endpointId: 'anthropic-messages',
      kind: 'input',
      contentHash: 'a'.repeat(64),
      schema: JSON.stringify({ type: 'object' }),
      createdAt: NOW,
    })

    await db.insert(changes).values({
      id: 'change-1',
      type: 'model.added',
      providerId: 'anthropic',
      subjectId: 'anthropic-claude-fable-5',
      summary: 'Model claude-fable-5 added',
      createdAt: NOW,
    })

    const model = await db.query.models.findFirst({
      where: eq(models.id, 'anthropic-claude-fable-5'),
      with: { provider: true },
    })
    expect(model?.activity).toBe('chat')
    expect(model?.provider.displayName).toBe('Anthropic')
    expect(model?.modalities).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    })

    const version = await db.query.schemaVersions.findFirst({
      where: eq(schemaVersions.contentHash, 'a'.repeat(64)),
      with: { endpoint: true },
    })
    expect(version?.kind).toBe('input')
    expect(version?.endpoint.path).toBe('/v1/messages')

    const changeRows = await db
      .select()
      .from(changes)
      .where(eq(changes.providerId, 'anthropic'))
    expect(changeRows).toHaveLength(1)
    expect(changeRows[0]?.type).toBe('model.added')
  })

  it('enforces the providers foreign key', async () => {
    const db = getDb(env)
    await expect(
      db.insert(models).values({
        id: 'orphan-model',
        providerId: 'no-such-provider',
        rawId: 'orphan',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      }),
    ).rejects.toThrow()
  })
})

describe('migration 0014: capabilities become flag maps', () => {
  it('converts every old shape, moves native objects, and is safe to re-run', async () => {
    const migration = env.TEST_MIGRATIONS.find((m) =>
      m.name.startsWith('0014_capability_flag_maps'),
    )
    if (!migration) throw new Error('migration 0014 not found')
    await env.DB.prepare(
      "INSERT INTO providers (id, display_name, spec_source_url) VALUES ('mig', 'Mig', 'https://example.com')",
    ).run()
    // Old-shape rows, as stored before the migration. A deprecated row is
    // included: the poller never revisits those.
    const old: Record<string, string | null> = {
      list: '["tools","seed","tools"]',
      'list-deprecated': '["reasoning"]',
      empty: '[]',
      none: null,
      fal: '{"category":"text-to-image"}',
      'fal-wma': '{"category":"text-to-video","asyncapi":true}',
      'flag-only': '{"asyncapi":true}',
      byteplus:
        '{"domain":"VLM","taskType":["VisualQuestionAnswering"],"tools":{"function_calling":true},"structured_outputs":{"json_schema":false},"maxReasoningTokens":32768,"structuredOutputProbed":true}',
      'byteplus-image': '{"maxReferenceImages":14,"sizeTokens":["1K","2K"]}',
      elevenlabs:
        '{"canDoTextToSpeech":true,"canDoVoiceConversion":false,"languages":["en","ja"]}',
      // No `languages`: every value is a boolean, and it is still native.
      'elevenlabs-bare':
        '{"canDoTextToSpeech":true,"canDoVoiceConversion":false}',
      replicate: '{"visibility":"public","official":true}',
      reactor: '{"pricingName":"fast-h3","upstreamId":"3dc9"}',
      // Already converted: a map, with a stated no.
      map: '{"tools":true,"reasoning":false}',
    }
    for (const [rawId, capabilities] of Object.entries(old)) {
      await env.DB.prepare(
        'INSERT INTO models (id, provider_id, raw_id, capabilities, first_seen_at, last_seen_at, deprecated_at) VALUES (?, ?, ?, ?, 1, 1, ?)',
      )
        .bind(
          `mig-${rawId}`,
          'mig',
          rawId,
          capabilities,
          rawId === 'list-deprecated' ? 2 : null,
        )
        .run()
    }
    const run = async () => {
      for (const query of migration.queries) await env.DB.prepare(query).run()
      const { results } = await env.DB.prepare(
        "SELECT raw_id, capabilities, provider_metadata FROM models WHERE provider_id = 'mig'",
      ).all<{
        raw_id: string
        capabilities: string | null
        provider_metadata: string | null
      }>()
      return Object.fromEntries(
        results.map((row) => [
          row.raw_id,
          [row.capabilities, row.provider_metadata].map((json) =>
            json === null ? null : (JSON.parse(json) as unknown),
          ),
        ]),
      )
    }

    const once = await run()
    expect(once).toEqual({
      list: [{ tools: true, seed: true }, null],
      'list-deprecated': [{ reasoning: true }, null],
      // "Nothing stated": the next poll writes an exact row's noes.
      empty: [null, null],
      none: [null, null],
      fal: [null, { category: 'text-to-image' }],
      // Split: the flag stays, the listing object moves.
      'fal-wma': [{ asyncapi: true }, { category: 'text-to-video' }],
      'flag-only': [{ asyncapi: true }, null],
      // Native `tools` / `structured_outputs` objects are not flags.
      byteplus: [
        null,
        {
          domain: 'VLM',
          taskType: ['VisualQuestionAnswering'],
          tools: { function_calling: true },
          structured_outputs: { json_schema: false },
          maxReasoningTokens: 32768,
          structuredOutputProbed: true,
        },
      ],
      'byteplus-image': [
        null,
        { maxReferenceImages: 14, sizeTokens: ['1K', '2K'] },
      ],
      elevenlabs: [
        null,
        {
          canDoTextToSpeech: true,
          canDoVoiceConversion: false,
          languages: ['en', 'ja'],
        },
      ],
      'elevenlabs-bare': [
        null,
        { canDoTextToSpeech: true, canDoVoiceConversion: false },
      ],
      replicate: [null, { visibility: 'public', official: true }],
      reactor: [null, { pricingName: 'fast-h3', upstreamId: '3dc9' }],
      map: [{ tools: true, reasoning: false }, null],
    })
    // No row holds anything but a boolean map or null.
    const { results: odd } = await env.DB.prepare(
      "SELECT m.raw_id FROM models m, json_each(m.capabilities) e WHERE m.provider_id = 'mig' AND (json_type(m.capabilities) <> 'object' OR e.type NOT IN ('true', 'false'))",
    ).all()
    expect(odd).toEqual([])

    expect(await run()).toEqual(once)
  })
})
