import { describe, expect, it } from 'vitest'

import { providerSeeds, seedFromAdapter } from './seed-providers.ts'
import type { ProviderConfig } from '#/server/providers/types.ts'

const CORE_IDS = [
  'openai',
  'anthropic',
  'gemini',
  'grok',
  'elevenlabs',
  'openrouter',
  'fal',
  'byteplus',
] as const

describe('providerSeeds', () => {
  it('includes the original 8 providers and keeps every id unique', () => {
    const ids = providerSeeds.map((p) => p.id)
    expect(ids.slice(0, CORE_IDS.length)).toEqual([...CORE_IDS])
    expect(new Set(ids).size).toBe(ids.length)
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

  it('keeps OpenRouter keyless', () => {
    const openrouter = providerSeeds.find((p) => p.id === 'openrouter')
    expect(openrouter?.authEnvVar).toBeNull()
  })
})

describe('seedFromAdapter', () => {
  const stub = {
    id: 'acme',
    displayName: 'Acme',
    specSourceUrl: 'https://example.com/openapi.json',
    modelsEndpoint: 'https://api.example.com/v1/models',
    authEnvVar: 'MISTRAL_API_KEY',
    defaultDerivation: 'upstream-spec',
    fetchSpec: () =>
      Promise.resolve({
        specs: [],
        sources: [],
        outputStrategy: 'post-200' as const,
      }),
    listModels: () => Promise.resolve({ models: [] }),
    classify: () => null,
  } satisfies ProviderConfig

  it('copies seed metadata off the adapter', () => {
    expect(seedFromAdapter(stub)).toEqual({
      id: 'acme',
      displayName: 'Acme',
      specSourceUrl: 'https://example.com/openapi.json',
      modelsEndpoint: 'https://api.example.com/v1/models',
      authEnvVar: 'MISTRAL_API_KEY',
    })
  })

  it('rejects an adapter with no spec source', () => {
    const { specSourceUrl: _drop, ...rest } = stub
    void _drop
    expect(() => seedFromAdapter(rest)).toThrow(/specSourceUrl/)
  })
})
