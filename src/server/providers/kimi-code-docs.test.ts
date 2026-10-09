import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { KIMI_CODE_MODELS_URL, parseKimiCodeModels } from './kimi-code-docs.ts'

const html = readFileSync(
  new URL('./fixtures/kimi-code-models.html.txt', import.meta.url),
  'utf8',
)
const source = {
  derivation: 'docs-derived' as const,
  sourceUrl: KIMI_CODE_MODELS_URL,
  sourceHash: 'test-fixture',
}

describe('native Kimi Coding model documentation', () => {
  it('reads all native IDs and their own context cells', () => {
    const models = parseKimiCodeModels(html, source)
    expect(models.map((model) => model.rawId)).toEqual([
      'k3',
      'k3-256k',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ])
    expect(models.map((model) => model.contextWindow)).toEqual([
      1048576, 262144, 1048576, 262144,
    ])
    expect(models[0]?.providerMetadata?.['Availability (new plans)']).toContain(
      '1M context for Pro and above',
    )
    expect(
      models.every(
        (model) =>
          model.pricing === null &&
          model.maxOutput === null &&
          model.displayName === null &&
          model.requestMap === null,
      ),
    ).toBe(true)
  })
  it('reads model-specific effort values without inferring mandatory thinking', () => {
    const models = parseKimiCodeModels(html, source)
    expect(models[0]?.reasoning).toEqual({
      mode: 'effort',
      mandatory: null,
      efforts: ['low', 'high', 'max'],
    })
    expect(models[3]?.reasoning).toBeNull()
    expect(models[3]?.capabilities).toEqual(['reasoning'])
  })
  it('publishes stated media inputs and leaves output unsourced', () => {
    const models = parseKimiCodeModels(html, source)
    expect(models[1]?.modalities).toEqual({ input: ['image'], output: null })
    expect(models[2]?.modalities).toEqual({
      input: ['image', 'video'],
      output: null,
    })
    expect(models[2]?.factSources?.modalities).toMatchObject({
      sourceUrl: KIMI_CODE_MODELS_URL,
    })
  })
  it('reads a newly named model rather than using a static ID registry', () => {
    const changed = html.replace(
      /(<th[^>]*><code[^>]*>)k3(<\/code>)/,
      '$1future-model$2',
    )
    expect(parseKimiCodeModels(changed, source)[0]?.rawId).toBe('future-model')
  })
  it('returns null for a legitimately absent fact row', () => {
    const changed = html.replace(
      /<tr\b[^>]*><td\b[^>]*>Context window<\/td>[\s\S]*?<\/tr>/,
      '',
    )
    expect(
      parseKimiCodeModels(changed, source).every(
        (model) => model.contextWindow === null,
      ),
    ).toBe(true)
  })
  it('rejects HTML shells, table-width changes and duplicate native IDs', () => {
    expect(() => parseKimiCodeModels('<html>login</html>', source)).toThrow(
      /Model ID table/,
    )
    expect(() =>
      parseKimiCodeModels(html.replace(/<td\b[^>]*>Regular<\/td>/, ''), source),
    ).toThrow(/widths/)
    expect(() =>
      parseKimiCodeModels(
        html.replace(/(<th[^>]*><code[^>]*>)k3-256k(<\/code>)/, '$1k3$2'),
        source,
      ),
    ).toThrow(/duplicate/)
  })
  it('rejects unreadable stated context or media facts rather than substituting null', () => {
    expect(() =>
      parseKimiCodeModels(
        html.replace('1048576</code>', 'unknown</code>'),
        source,
      ),
    ).toThrow(/context window/)
    expect(() =>
      parseKimiCodeModels(html.replace('Image, video', 'Image, radar'), source),
    ).toThrow(/modalities/)
  })
})
