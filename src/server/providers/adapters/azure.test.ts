import { afterEach, describe, expect, it } from 'vitest'

import { AZURE_MODELS_URL, provider } from './azure.ts'

/** Excerpt of the Microsoft models article (2026-10-04). */
const FIXTURE = `
<table>
  <tr>
    <td>GPT-5.6 series</td>
    <td><code>gpt-5.6-sol</code>, <code>gpt-5.6-terra</code>, <code>gpt-5.6-luna</code></td>
  </tr>
  <tr><td>o-series</td><td><code>o4-mini</code></td></tr>
</table>
<code>max_output_tokens</code>
`

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('azure', () => {
  it('lists code-tag model ids and leaves prices null', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === AZURE_MODELS_URL) {
        return Promise.resolve(new Response(FIXTURE))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.models.map((model) => model.rawId)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'o4-mini',
    ])
    expect(listed.models.every((model) => model.pricing == null)).toBe(true)
    expect(spec.skipped).toContain('skipped')
    expect(urls).toEqual([AZURE_MODELS_URL])
  })
})
