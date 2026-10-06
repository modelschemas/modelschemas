import { describe, expect, it } from 'vitest'

import { GPT_4O } from '../../../packages/rate-card/src/fixtures/gpt-4o.ts'

import {
  MODELS_DEV_API_URL,
  isModelsDevRateCard,
  storedCardIsPrior,
} from './retire-models-dev.ts'

describe('storedCardIsPrior', () => {
  it('keeps a provider card and rejects a models.dev card', () => {
    expect(storedCardIsPrior(GPT_4O)).toBe(true)
    const dev = {
      ...GPT_4O,
      source: { ...GPT_4O.source, url: MODELS_DEV_API_URL },
    }
    expect(isModelsDevRateCard(dev)).toBe(true)
    expect(storedCardIsPrior(dev)).toBe(false)
    expect(storedCardIsPrior(null)).toBe(false)
  })
})
