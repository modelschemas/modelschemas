import { describe, expect, it } from 'vitest'

import { providerSeeds } from './seed-providers.ts'

describe('providerSeeds', () => {
  it('contains the 8 monitored providers with unique slug ids', () => {
    const ids = providerSeeds.map((p) => p.id)
    expect(ids).toEqual([
      'openai',
      'anthropic',
      'gemini',
      'grok',
      'elevenlabs',
      'openrouter',
      'fal',
      'byteplus',
    ])
    expect(new Set(ids).size).toBe(8)
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    }
  })

  it('uses https spec sources and models endpoints', () => {
    for (const p of providerSeeds) {
      expect(p.specSourceUrl).toMatch(/^https:\/\//)
      expect(p.modelsEndpoint).toMatch(/^https:\/\//)
    }
  })

  it('only OpenRouter and BytePlus are keyless', () => {
    const keyless = providerSeeds.filter((p) => p.authEnvVar == null)
    expect(keyless.map((p) => p.id)).toEqual(['openrouter', 'byteplus'])
  })
})
