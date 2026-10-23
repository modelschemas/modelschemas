import { describe, expect, it } from 'vitest'

import {
  commandFamilyPageUrls,
  parseCohereModelPage,
} from './cohere-model-pages.ts'

const SOURCE = {
  url: 'https://docs.cohere.com/docs/command-a-plus',
  hash: 'abc',
  extractedAt: '2026-10-23T00:00:00.000Z',
}

function page(box: string): string {
  return `<html><body><h1>Model</h1> ${box} <h2>Description</h2><p>later Pricing mention</p></body></html>`
}

const FREE = page(`
  <div>Pricing</div>
  <p>For both trial keys and production keys, Command A+ is free until rate limits are reached. Learn more about rate limits.</p>
  <p>Command A+ can be used in production through Cohere's Model Vault.</p>
  <div>Specifications</div>
  <p>Context Window: 128,000 tokens</p>
  <p>Max Output Tokens: 64,000 tokens</p>
  <p>Knowledge Cutoff: April 1, 2025</p>
  <div>Model ID</div>
  <p>command-a-plus-05-2026</p>
  <p>Try in Playground</p>
`)

describe('command model pages', () => {
  it('reads the family links as docs URLs', () => {
    const markdown = `* The Command family of models includes [Command A+](command-a-plus), [Command A](command-a),
  [Command A Reasoning](command-a-reasoning), and [Command](command).`
    expect(commandFamilyPageUrls(markdown)).toEqual([
      'https://docs.cohere.com/docs/command-a-plus',
      'https://docs.cohere.com/docs/command-a',
      'https://docs.cohere.com/docs/command-a-reasoning',
      'https://docs.cohere.com/docs/command',
    ])
    expect(commandFamilyPageUrls('# Models\nno family sentence')).toEqual([])
  })

  it('stores a $0 card and the cutoff, and leaves the context cell', () => {
    const parsed = parseCohereModelPage(FREE, SOURCE)
    expect(parsed?.id).toBe('command-a-plus-05-2026')
    expect(parsed?.facts.pricing).toMatchObject({ price: 0 })
    expect(parsed?.facts.pricing?.tables).toEqual({
      rate: { base: { input_tokens: 0, output_tokens: 0 } },
    })
    expect(parsed?.facts.knowledgeCutoff).toBe('2025-04-01')
    expect(parsed?.facts).not.toHaveProperty('contextWindow')
  })

  it('reads a token price the showcase states', () => {
    const html = page(`
      Pricing Input $ 2.5 / 1M tokens Output $ 10 / 1M tokens
      Specifications Context Window: 256,000 tokens
      Knowledge Cutoff: June 1, 2024
      Model ID command-a-03-2025
      Try in Playground
    `)
    const parsed = parseCohereModelPage(html, SOURCE)
    expect(parsed?.facts.pricing?.tables).toEqual({
      rate: { base: { input_tokens: 2.5e-6, output_tokens: 1e-5 } },
    })
    expect(parsed?.facts.knowledgeCutoff).toBe('2024-06-01')
  })

  it('writes nothing when the price sentence changes, or both forms appear', () => {
    const reworded = FREE.replace(
      'is free until rate limits are reached',
      'is free for trial keys',
    )
    expect(
      parseCohereModelPage(reworded, SOURCE)?.facts.pricing,
    ).toBeUndefined()
    expect(parseCohereModelPage(reworded, SOURCE)?.facts.knowledgeCutoff).toBe(
      '2025-04-01',
    )
    const both = FREE.replace(
      'Specifications',
      'Input $ 2.5 / 1M tokens Output $ 10 / 1M tokens Specifications',
    )
    expect(parseCohereModelPage(both, SOURCE)?.facts.pricing).toBeUndefined()
    expect(
      parseCohereModelPage('<html>Page Not Found</html>', SOURCE),
    ).toBeNull()
  })
})
