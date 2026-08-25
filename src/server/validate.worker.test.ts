import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { getDb } from '../db/index.ts'
import type { Db } from '../db/index.ts'
import { endpoints, models, providers, schemaVersions } from '../db/schema.ts'
import { parseValidateBody, validatePayload } from './validate.ts'

const NOW = 1_781_150_000

// Trimmed-down Anthropic /v1/messages input schema (the real one is synced
// from the spec; this captures its load-bearing constraints).
const ANTHROPIC_MESSAGES_INPUT = {
  type: 'object',
  required: ['model', 'max_tokens', 'messages'],
  properties: {
    model: { type: 'string' },
    max_tokens: { type: 'integer', minimum: 1 },
    messages: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/$defs/InputMessage' },
    },
  },
  $defs: {
    InputMessage: {
      type: 'object',
      required: ['role', 'content'],
      properties: {
        role: { type: 'string', enum: ['user', 'assistant'] },
        content: { type: 'string' },
      },
    },
  },
}

let db: Db

beforeAll(async () => {
  db = getDb(env)
  await db.insert(providers).values({
    id: 'val-anthropic',
    displayName: 'Anthropic (validate fixture)',
    specSourceUrl: 'https://example.com/spec.yml',
  })
  await db.insert(endpoints).values({
    id: 'val-anthropic/v1/messages',
    providerId: 'val-anthropic',
    activity: 'chat',
    method: 'POST',
    path: '/v1/messages',
  })
  await db.insert(schemaVersions).values({
    id: 'val-anthropic/v1/messages:input:1',
    endpointId: 'val-anthropic/v1/messages',
    kind: 'input',
    contentHash: 'b'.repeat(64),
    schema: JSON.stringify(ANTHROPIC_MESSAGES_INPUT),
    createdAt: NOW,
  })
})

describe('validatePayload', () => {
  it('accepts a valid Anthropic messages payload', async () => {
    const outcome = await validatePayload(db, {
      provider: 'val-anthropic',
      endpointId: 'v1/messages',
      payload: {
        model: 'claude-fable-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
      },
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.valid).toBe(true)
      expect(outcome.result.errors).toEqual([])
      expect(outcome.result.kind).toBe('input')
      expect(outcome.result.contentHash).toBe('b'.repeat(64))
    }
  })

  it('rejects an invalid payload with structured errors', async () => {
    const outcome = await validatePayload(db, {
      provider: 'val-anthropic',
      endpointId: 'v1/messages',
      payload: {
        model: 'claude-fable-5',
        // max_tokens missing entirely; bad role inside $defs-referenced item
        messages: [{ role: 'system', content: 'Hello' }],
      },
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.valid).toBe(false)
      expect(outcome.result.errors.length).toBeGreaterThan(0)
      for (const error of outcome.result.errors) {
        expect(typeof error.path).toBe('string')
        expect(typeof error.message).toBe('string')
        expect(typeof error.keyword).toBe('string')
      }
      const keywords = outcome.result.errors.map((e) => e.keyword)
      expect(keywords).toContain('required')
    }
  })

  it('404s with remediation for unknown endpoints or missing schemas', async () => {
    const unknown = await validatePayload(db, {
      provider: 'val-anthropic',
      endpointId: 'nope',
      payload: {},
    })
    expect(unknown).toMatchObject({
      ok: false,
      status: 404,
      code: 'unknown_endpoint',
    })

    const noOutput = await validatePayload(db, {
      provider: 'val-anthropic',
      endpointId: 'v1/messages',
      kind: 'output',
      payload: {},
    })
    expect(noOutput).toMatchObject({
      ok: false,
      status: 404,
      code: 'no_schema',
    })
  })

  it('resolves a grok model rawId onto the bound generation route', async () => {
    await db
      .insert(providers)
      .values({
        id: 'grok',
        displayName: 'xAI Grok',
        specSourceUrl: 'https://example.com/g.json',
      })
      .onConflictDoNothing()
    await db.insert(endpoints).values({
      id: 'grok/v1/images/generations',
      providerId: 'grok',
      activity: 'image',
      method: 'POST',
      path: '/v1/images/generations',
    })
    await db.insert(schemaVersions).values({
      id: 'grok/v1/images/generations:input:1',
      endpointId: 'grok/v1/images/generations',
      kind: 'input',
      contentHash: 'd'.repeat(64),
      schema: JSON.stringify({
        type: 'object',
        properties: { model: { type: 'string' }, prompt: { type: 'string' } },
      }),
      createdAt: NOW,
    })
    await db.insert(models).values({
      id: 'grok-grok-imagine-image-2-0',
      providerId: 'grok',
      rawId: 'grok-imagine-image-2.0',
      activity: 'image',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    })

    const outcome = await validatePayload(db, {
      provider: 'grok',
      endpointId: 'grok-imagine-image-2.0',
      payload: { model: 'grok-imagine-image-2.0', prompt: 'a cat' },
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.valid).toBe(true)
      expect(outcome.result.endpointId).toBe('v1/images/generations')
    }
  })
})

describe('parseValidateBody', () => {
  it('accepts well-formed bodies and rejects malformed ones', () => {
    expect(
      parseValidateBody({ provider: 'p', endpointId: 'e', payload: {} }),
    ).not.toBeNull()
    expect(
      parseValidateBody({
        provider: 'p',
        endpointId: 'e',
        kind: 'output',
        payload: null,
      }),
    ).not.toBeNull()
    expect(parseValidateBody({ provider: 'p', payload: {} })).toBeNull()
    expect(
      parseValidateBody({
        provider: 'p',
        endpointId: 'e',
        kind: 'sideways',
        payload: {},
      }),
    ).toBeNull()
    expect(parseValidateBody({ provider: 'p', endpointId: 'e' })).toBeNull()
    expect(parseValidateBody('nope')).toBeNull()
  })
})
