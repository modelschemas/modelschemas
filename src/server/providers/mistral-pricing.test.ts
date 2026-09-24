import { describe, expect, it } from 'vitest'

import { parseMistralApiIds, parseMistralPricing } from './mistral-pricing.ts'

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

  it('reads the API ids a model page lists for the slug', () => {
    const html =
      'other "names":["docs","agents"] payload names\\":[\\"mistral-large-2512\\",\\"mistral-large-latest\\"]'
    expect(parseMistralApiIds(html, 'mistral-large-3-25-12')).toEqual([
      'mistral-large-2512',
      'mistral-large-latest',
    ])
  })
})
