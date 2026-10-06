import { describe, expect, it } from 'vitest'

import {
  azureModelPricing,
  azureModelRates,
  AZURE_PRICES_URL,
  parseAzureMeters,
  parseAzureSku,
} from './azure-pricing.ts'

const item = (skuName: string, unitOfMeasure: string, retailPrice: number) => ({
  skuName,
  unitOfMeasure,
  retailPrice,
})

/** Items from the Retail Prices API, `eastus2` (2026-10-06). */
const PRICE_ITEMS = [
  item('5.4 mini Inp Gl', '1M', 0.75),
  item('5.4 mini cd Inp Gl', '1M', 0.075),
  item('5.4 mini Opt Gl', '1M', 4.5),
  item('5.4 mini Inp Dz', '1M', 0.825),
  item('5.4 mini Batch Inp Gl', '1M', 0.375),
  item('5.4 mini pp Inp Gl', '1M', 1.5),
  item('54 mini Inp Flex Gl', '1M', 0.375),
  item('5.4 inp Gl', '1M', 2.5),
  item('5.4 opt Gl', '1M', 15),
  item('5.4 longco inp Gl', '1M', 5),
  item('5.4 longco opt Gl', '1M', 22.5),
  item('6-sol ShortCo Inp Std Gl', '1M', 2),
  item('6-sol ShortCo Cd Inp Std Gl', '1M', 0.2),
  item('6-sol ShortCo Cd Wr Std Gl', '1M', 2.5),
  item('6-sol ShortCo Opt Std Gl', '1M', 10),
  item('6-sol ShortCo Inp PP Gl', '1M', 4),
  item('gpt 4o 0513 Input global', '1K', 0.005),
  item('gpt 4o 0513 Output global', '1K', 0.015),
  item('gpt 4o 1120 Inp glbl', '1K', 0.0025),
  item('gpt 4o 1120 cached Inp glbl', '1K', 0.00125),
  item('gpt 4o 1120 Outp glbl', '1K', 0.01),
  item('gpt-4o-aud-1217 Inp glbl', '1K', 0.04),
  item('o3 0416 Inp glbl', '1K', 0.002),
  item('o3 0416 Outp glbl', '1K', 0.008),
  item('o1 mini input glbl', '1K', 0.0011),
  item('o1 mini output glbl', '1K', 0.0044),
  item('chat-latest 08062026 inp Gl', '1M', 5),
  item('chat-latest 08062026 opt Gl', '1M', 30),
  item('gpt-oss-120B Inp glbl', '1K', 0.00015),
  item('o4 mini ft hosting Dz', '1 Hour', 1.7),
  item('Code-Interpreter-global', '1', 0.03),
]

describe('azure SKU names', () => {
  it('reads the lever, version, and model words', () => {
    expect(parseAzureSku('5.4 mini cd Inp Gl')).toEqual({
      name: '54mini',
      version: null,
      lever: 'cache_read_tokens',
      long: false,
    })
    expect(parseAzureSku('gpt-4o-0806-Outp-glbl')).toEqual({
      name: 'gpt4o',
      version: '0806',
      lever: 'output_tokens',
      long: false,
    })
    expect(parseAzureSku('6-astra LongCo Cd Wr Std Gl')).toEqual({
      name: '6astra',
      version: null,
      lever: 'cache_write_tokens',
      long: true,
    })
    expect(parseAzureSku('chat-latest 08062026 inp Gl')).toMatchObject({
      name: 'chatlatest',
      version: '0806',
    })
  })

  it('skips other deployments and SKUs with no direction', () => {
    expect(parseAzureSku('5.4 mini Inp Dz')).toBeNull()
    expect(parseAzureSku('o3 0416 Inp regnl')).toBeNull()
    expect(parseAzureSku('Code-Interpreter-global')).toBeNull()
    expect(parseAzureSku('text-embedding-3-small-glbl')).toBeNull()
  })

  it('keeps another tier in the model name so it matches nothing', () => {
    expect(parseAzureSku('5.4 mini Batch Inp Gl')?.name).toBe('54minibatch')
    expect(parseAzureSku('5.4 mini pp Inp Gl')?.name).toBe('54minipp')
    expect(parseAzureSku('54 mini Inp Flex Gl')?.name).toBe('54miniflex')
    expect(parseAzureSku('gpt-4o-aud-1217 Inp glbl')?.name).toBe('gpt4oaud')
  })
})

describe('azure model rates', () => {
  const meters = parseAzureMeters(PRICE_ITEMS)
  const perMillion = (id: string, version: string | null) => {
    const rates = azureModelRates(meters, id, version)
    return (
      rates &&
      Object.fromEntries(
        Object.entries(rates).map(([lever, rate]) => [
          lever,
          Number((rate * 1e6).toFixed(6)),
        ]),
      )
    )
  }

  it('prices the Global Standard tier per token', () => {
    expect(perMillion('gpt-5.4-mini', '2026-03-17')).toEqual({
      input_tokens: 0.75,
      cache_read_tokens: 0.075,
      output_tokens: 4.5,
    })
    expect(perMillion('o1-mini', '2024-09-12')).toEqual({
      input_tokens: 1.1,
      output_tokens: 4.4,
    })
  })

  it('prices the listed version only', () => {
    expect(perMillion('gpt-4o', '2024-11-20')).toEqual({
      input_tokens: 2.5,
      cache_read_tokens: 1.25,
      output_tokens: 10,
    })
    expect(perMillion('gpt-4o', '2024-05-13')).toEqual({
      input_tokens: 5,
      output_tokens: 15,
    })
    expect(perMillion('gpt-4o', '2024-08-06')).toBeNull()
    expect(perMillion('gpt-chat-latest', '2026-08-06')).toEqual({
      input_tokens: 5,
      output_tokens: 30,
    })
    expect(perMillion('o3', null)).toBeNull()
  })

  it('refuses a model with a long-context band', () => {
    expect(perMillion('gpt-5.4', '2026-03-05')).toBeNull()
  })

  it('reads cache writes and ignores priority meters', () => {
    expect(perMillion('gpt-6-sol', '2026-09-22')).toEqual({
      input_tokens: 2,
      cache_read_tokens: 0.2,
      cache_write_tokens: 2.5,
      output_tokens: 10,
    })
  })

  it('refuses a model with no output meter or disagreeing meters', () => {
    expect(perMillion('gpt-oss-120b', null)).toBeNull()
    expect(perMillion('gpt-5.5', '2026-04-24')).toBeNull()
    const split = parseAzureMeters([
      item('o3 Inp glbl', '1K', 0.002),
      item('o3 input global', '1K', 0.003),
      item('o3 Outp glbl', '1K', 0.008),
    ])
    expect(azureModelRates(split, 'o3', null)).toBeNull()
  })

  it('compiles a card that carries its source', () => {
    const doc = { meters, hash: 'h', extractedAt: '2026-10-06T00:00:00.000Z' }
    const priced = azureModelPricing(doc, 'o3', '2025-04-16')
    expect(priced.pricing).toMatchObject({
      source: { url: AZURE_PRICES_URL, hash: 'h' },
    })
    expect(priced.factSources?.pricing).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: AZURE_PRICES_URL,
      sourceHash: 'h',
    })
    expect(azureModelPricing(doc, 'gpt-5.4', '2026-03-05')).toEqual({})
  })
})
