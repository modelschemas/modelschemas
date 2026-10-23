import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchByteplusDoc } from './byteplus-docs.ts'
import { docFixtureHtml } from './fixtures/byteplus-doc.ts'
import {
  BYTEPLUS_REASONING_URL,
  byteplusModelReasoning,
} from './reasoning-config.ts'

afterEach(() => vi.unstubAllGlobals())

/** What docs.byteplus.com served for the reasoning page on some fetches. */
const SHELL = readFileSync(
  new URL('./fixtures/byteplus-doc-shell.html.txt', import.meta.url),
  'utf8',
)

const RENDERED = docFixtureHtml([
  '## Adjust chain-of-thought length',
  'none',
  'high',
  [
    ['Supported models', 'Default value'],
    ['* seed-2-0-lite-260228', 'medium'],
  ],
])

function serve(...bodies: Array<string>) {
  const fetchMock = vi.fn((_url: string) => {
    const body = bodies.length > 1 ? bodies.shift() : bodies[0]
    return Promise.resolve(new Response(body))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('fetchByteplusDoc', () => {
  it('refetches when the doc center serves its unrendered shell', async () => {
    const fetchMock = serve(SHELL, RENDERED)
    await expect(fetchByteplusDoc(BYTEPLUS_REASONING_URL)).resolves.toBe(
      RENDERED,
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws once every attempt is the shell', async () => {
    const fetchMock = serve(SHELL)
    await expect(fetchByteplusDoc(BYTEPLUS_REASONING_URL)).rejects.toThrow(
      `${BYTEPLUS_REASONING_URL}: served the unrendered page shell 3 times`,
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry an HTTP error', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response('unavailable', { status: 503 })),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchByteplusDoc(BYTEPLUS_REASONING_URL)).rejects.toThrow(
      /503/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('byteplusModelReasoning', () => {
  it('reads the rendered page when the first fetch is the shell', async () => {
    serve(SHELL, RENDERED)
    const reasoning = await byteplusModelReasoning()
    expect(reasoning('seed-2-0-lite-260228', true).reasoning).toEqual({
      mode: 'effort',
      mandatory: false,
      efforts: ['none', 'high'],
    })
  })
})
