import { describe, expect, it } from 'vitest'

import { asListedModelId } from './listed-model.ts'

describe('asListedModelId', () => {
  it('is a compile-time brand — the runtime value is the raw string', () => {
    const id = asListedModelId('anthropic', 'claude-sonnet-4-5')
    expect(id).toBe('claude-sonnet-4-5')
    expect(typeof id).toBe('string')
  })
})
