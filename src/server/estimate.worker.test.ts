import { beforeAll, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

import { GPT_4O } from '../../packages/rate-card/src/fixtures/gpt-4o.ts'
import { getDb } from '../db/index.ts'
import type { Db } from '../db/index.ts'
import { models, providers } from '../db/schema.ts'
import { estimateCost, parseEstimateBody } from './estimate.ts'

const NOW = 1_781_150_000
let db: Db

beforeAll(async () => {
  db = getDb(env)
  await db.insert(providers).values({
    id: 'est-openai',
    displayName: 'Estimate OpenAI',
    specSourceUrl: 'https://example.com/o.json',
  })
  await db.insert(models).values([
    {
      id: 'est-openai-gpt-4o',
      providerId: 'est-openai',
      rawId: 'gpt-4o',
      activity: 'chat',
      displayName: 'GPT-4o',
      pricing: GPT_4O,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
    {
      id: 'est-openai-free',
      providerId: 'est-openai',
      rawId: 'free',
      activity: 'chat',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    },
  ])
})

describe('parseEstimateBody', () => {
  it('requires provider and model, and objects for request/usage', () => {
    expect(parseEstimateBody(null)).toBeNull()
    expect(parseEstimateBody({ provider: 'openai' })).toBeNull()
    expect(
      parseEstimateBody({ provider: 'openai', model: 'gpt-4o', request: [] }),
    ).toBeNull()
    expect(
      parseEstimateBody({
        provider: 'openai',
        model: 'gpt-4o',
        usage: { input_tokens: 1 },
      }),
    ).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      usage: { input_tokens: 1 },
    })
  })
})

describe('estimateCost', () => {
  it('prices a stored token card', async () => {
    const outcome = await estimateCost(db, {
      provider: 'est-openai',
      model: 'gpt-4o',
      usage: { input_tokens: 1200, output_tokens: 400 },
    })
    expect(outcome).toEqual({
      ok: true,
      result: { usd: 0.007, cardSource: GPT_4O.source },
    })
  })

  it('returns 404 unknown_model when the model is missing', async () => {
    const outcome = await estimateCost(db, {
      provider: 'est-openai',
      model: 'nope',
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(404)
      expect(outcome.code).toBe('unknown_model')
    }
  })

  it('returns 404 unknown_pricing when the model has no card', async () => {
    const outcome = await estimateCost(db, {
      provider: 'est-openai',
      model: 'free',
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(404)
      expect(outcome.code).toBe('unknown_pricing')
      expect(outcome.message).toContain('GET /v1/models/est-openai/free')
    }
  })

  it('returns 422 unbound_input naming the missing lever', async () => {
    const outcome = await estimateCost(db, {
      provider: 'est-openai',
      model: 'gpt-4o',
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(422)
      expect(outcome.code).toBe('unbound_input')
      expect(outcome.message).toContain('usage.input_tokens')
    }
  })
})
