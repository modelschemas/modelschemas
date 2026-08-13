import { describe, expect, it } from 'vitest'

import { provider } from './hyperbolic.ts'

describe('hyperbolic classify', () => {
  it('maps chat completions and drops platform paths', () => {
    expect(provider.classify('/chat/completions', {})).toBe('chat')
    expect(provider.classify('/v1/chat/completions', {})).toBe('chat')
    expect(provider.classify('/files', {})).toBeNull()
    expect(provider.classify('/v1/models', {})).toBeNull()
    expect(provider.classify('/fine_tuning/jobs', {})).toBeNull()
  })
})

describe('hyperbolic listModels', () => {
  it('skips when the secret is absent', async () => {
    const result = await provider.listModels({})
    expect(result.models).toEqual([])
    expect(result.skipped).toBe(
      'hyperbolic: HYPERBOLIC_API_KEY not set — skipped',
    )
  })
})
