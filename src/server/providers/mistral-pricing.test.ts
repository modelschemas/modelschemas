import { describe, expect, it } from 'vitest'

import {
  indexMistralApiIds,
  parseMistralApiIds,
  parseMistralPricing,
  parseMistralSamePrice,
} from './mistral-pricing.ts'

const PAGE = `<h2>Flagship models</h2>
<p>Prices /M Tokens</p>
<table>
<tr><td><a href="/models/mistral-large-3-25-12">Mistral Large 3</a></td><td>$0.5</td><td>$0.05</td><td>$1.5</td></tr>
<tr><td><a href="/models/codestral-embed-25-05">Codestral Embed</a></td><td>$0.15</td><td>$0.015</td><td>—</td></tr>
</table>
<h2>Specialized models</h2>
<p>Prices as marked</p>
<table>
<tr><td><a href="/models/ocr-4-1">OCR 4.1</a></td><td>$4 /1000 Pages</td><td>$0.4 /1000 Pages</td><td>—</td></tr>
<tr><td><a href="/models/leanstral-1-5">Leanstral</a></td><td>Free</td><td>Free</td><td>Free</td></tr>
</table>
<h2>Code models</h2>
<p>Prices /M Tokens</p>
<table>
<tr><td><a href="/models/codestral-25-08">Codestral</a></td><td>$0.3</td><td>$0.03</td><td>$0.9</td></tr>
</table>`

describe('mistral pricing page', () => {
  it('reads per-million tables and skips unit and free rows', () => {
    const rates = parseMistralPricing(PAGE)
    expect(rates.get('mistral-large-3-25-12')?.rates).toEqual({
      input_tokens: 0.5 / 1e6,
      cache_read_tokens: 0.05 / 1e6,
      output_tokens: 1.5 / 1e6,
    })
    expect(rates.get('codestral-25-08')?.rates.output_tokens).toBe(0.9 / 1e6)
    expect(rates.get('codestral-embed-25-05')?.rates).toEqual({
      input_tokens: 0.15 / 1e6,
      cache_read_tokens: 0.015 / 1e6,
    })
    expect(rates.has('ocr-4-1')).toBe(false)
    expect(rates.has('leanstral-1-5')).toBe(false)
  })

  it('refuses a priced slug whose model page named no API ids', () => {
    const rates = parseMistralPricing(PAGE)
    expect(() =>
      indexMistralApiIds(rates, [
        {
          slug: 'mistral-large-3-25-12',
          ids: ['mistral-large-2512'],
          hash: 'a',
        },
      ]),
    ).toThrow(
      'mistral model pages: no API ids for codestral-embed-25-05, codestral-25-08',
    )
  })

  it('copies a changelog same-price chat id and skips unpriced rows', () => {
    const rates = parseMistralPricing(PAGE)
    const byId = indexMistralApiIds(rates, [
      {
        slug: 'mistral-large-3-25-12',
        ids: ['mistral-large-2512'],
        hash: 'a',
      },
      { slug: 'codestral-embed-25-05', ids: ['codestral-embed'], hash: 'b' },
      { slug: 'codestral-25-08', ids: ['zai-glm-5-3'], hash: 'c' },
    ])
    const changelog = `
      Z.ai GLM 5.2 ( zai-glm-5-2 ) is deprecated and retires on October 31, 2026.
      Use Z.ai GLM 5.3 ( zai-glm-5-3 ) instead, at the same price.
      OCR 4.0 ( mistral-ocr-4-0 ) is deprecated. Use OCR 4.1 ( mistral-ocr-4-1 ) instead, at the same price.
      Leanstral 1.5 ( labs-leanstral-1-5 ) is deprecated and retires on September 30, 2026.
    `
    for (const [from, to] of parseMistralSamePrice(changelog)) {
      const row = byId.get(to)
      if (!row || byId.has(from)) continue
      byId.set(from, row)
    }
    expect(byId.get('zai-glm-5-2')?.rates.output_tokens).toBe(0.9 / 1e6)
    expect(byId.has('mistral-ocr-4-0')).toBe(false)
    expect(byId.has('labs-leanstral-1-5')).toBe(false)
    expect(byId.has('magistral-medium-latest')).toBe(false)
  })

  it('reads the API ids a model page lists for the slug', () => {
    const html =
      'other "names":["docs","agents"] payload names\\":[\\"mistral-large-2512\\",\\"mistral-large-latest\\"]'
    expect(parseMistralApiIds(html, 'mistral-large-3-25-12')).toEqual([
      'mistral-large-2512',
      'mistral-large-latest',
    ])
  })
})
