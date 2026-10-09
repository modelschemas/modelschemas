import { price } from '@modelschemas/rate-card'
import { describe, expect, it } from 'vitest'

import { mistralModelPage, tip } from './fixtures/mistral-model-page.ts'
import {
  copyMistralAliasFacts,
  indexMistralApiIds,
  indexMistralModalities,
  mistralIndexSlugFor,
  mistralModelPricing,
  mistralRateCard,
  parseMistralApiIds,
  parseMistralModelIndex,
  parseMistralPageMaxOutput,
  parseMistralPageModalities,
  parseMistralPagePrice,
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
<tr><td><a href="/models/voxtral-mini-transcribe-26-02">Voxtral</a></td><td>$0.003 /Min</td><td>—</td><td>—</td></tr>
<tr><td><a href="/models/voxtral-tts-26-03">TTS</a></td><td>$0 /M Chars</td><td>$0 /M Chars</td><td>$16 /M Chars</td></tr>
<tr><td><a href="/models/mixed-units">Mixed</a></td><td>$1 /Min</td><td>—</td><td>$2 /M Chars</td></tr>
<tr><td><a href="/models/leanstral-1-5">Leanstral</a></td><td>Free</td><td>Free</td><td>Free</td></tr>
</table>
<h2>Code models</h2>
<p>Prices /M Tokens</p>
<table>
<tr><td><a href="/models/codestral-25-08">Codestral</a></td><td>$0.3</td><td>$0.03</td><td>$0.9</td></tr>
</table>`

describe('mistral pricing page', () => {
  it('reads per-million tables and unit rows, and skips free or mixed units', () => {
    const rates = parseMistralPricing(PAGE)
    expect(rates.get('mistral-large-3-25-12')).toEqual({
      kind: 'tokens',
      rates: {
        input_tokens: 0.5 / 1e6,
        cache_read_tokens: 0.05 / 1e6,
        output_tokens: 1.5 / 1e6,
      },
    })
    const codestral = rates.get('codestral-25-08')
    expect(codestral?.kind === 'tokens' && codestral.rates.output_tokens).toBe(
      0.9 / 1e6,
    )
    expect(rates.get('codestral-embed-25-05')).toEqual({
      kind: 'tokens',
      rates: {
        input_tokens: 0.15 / 1e6,
        cache_read_tokens: 0.015 / 1e6,
      },
    })
    expect(rates.get('ocr-4-1')).toEqual({
      kind: 'unit',
      meters: [
        { param: 'pages', rate: 4 / 1000 },
        { param: 'cached_pages', rate: 0.4 / 1000, default: 0 },
      ],
    })
    expect(rates.get('voxtral-mini-transcribe-26-02')).toEqual({
      kind: 'unit',
      meters: [{ param: 'audio_minutes', rate: 0.003 }],
    })
    expect(rates.get('voxtral-tts-26-03')).toEqual({
      kind: 'unit',
      meters: [{ param: 'output_characters', rate: 16 / 1e6 }],
    })
    expect(rates.has('mixed-units')).toBe(false)
    expect(rates.has('leanstral-1-5')).toBe(false)
    expect(rates.has('mistral-embed')).toBe(false)
  })

  it('uses the current sale amount, including an unreadable historical quote', () => {
    const sale = `<h2>Flagship</h2><p>Prices /M Tokens</p><table>
<tr><td><a href="/models/synthetic-sale">Sale</a></td>
<td><del><span>Original price: </span>$9</del><ins><span>Sale price: </span>$3</ins></td>
<td><del>unknown historical amount</del><ins>$0.2</ins></td>
<td><del>$12</del><ins>$4</ins></td></tr></table>`
    expect(parseMistralPricing(sale).get('synthetic-sale')).toEqual({
      kind: 'tokens',
      rates: {
        input_tokens: 3 / 1e6,
        cache_read_tokens: 0.2 / 1e6,
        output_tokens: 4 / 1e6,
      },
    })
  })

  it.each([
    '<del>$9</del>',
    '<del>$9</del><ins>unknown</ins>',
    '<del>$9</del><ins>$3</ins><ins>$2</ins>',
  ])(
    'fails unreadable current sale markup instead of using the old rate: %s',
    (cell) => {
      const html = `<h2>Flagship</h2><p>Prices /M Tokens</p><table>
<tr><td><a href="/models/synthetic-sale">Sale</a></td><td>${cell}</td><td>$1</td><td>$4</td></tr></table>`
      expect(() => parseMistralPricing(html)).toThrow(/current sale price/)
    },
  )

  it('compiles a unit card from the parsed meters', () => {
    const row = parseMistralPricing(PAGE).get('ocr-4-1')
    expect(row?.kind).toBe('unit')
    if (row?.kind !== 'unit') return
    const card = mistralRateCard(row, {
      url: 'https://docs.mistral.ai/inference/pricing',
      hash: 'a'.repeat(64),
      extractedAt: '2026-10-03T00:00:00.000Z',
    })
    expect(card).not.toBeNull()
    if (!card) return
    expect(price(card, {}, { pages: 1000 })).toBeCloseTo(4, 9)
    expect(price(card, {}, { pages: 1000, cached_pages: 1000 })).toBeCloseTo(
      4.4,
      9,
    )
    const audio = parseMistralPricing(PAGE).get('voxtral-mini-transcribe-26-02')
    if (audio?.kind !== 'unit') throw new Error('expected an audio unit row')
    const audioCard = mistralRateCard(audio, {
      url: 'https://docs.mistral.ai/inference/pricing',
      hash: 'b'.repeat(64),
      extractedAt: '2026-10-03T00:00:00.000Z',
    })
    if (!audioCard) throw new Error('expected an audio card')
    expect(price(audioCard, {}, { audio_minutes: 10 })).toBeCloseTo(0.03, 9)
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
      'mistral model pages: no API ids for codestral-embed-25-05, ocr-4-1, voxtral-mini-transcribe-26-02, voxtral-tts-26-03, codestral-25-08',
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
      {
        slug: 'ocr-4-1',
        ids: ['mistral-ocr-4-1', 'mistral-ocr-latest'],
        hash: 'd',
      },
      {
        slug: 'voxtral-mini-transcribe-26-02',
        ids: ['voxtral-mini-2602'],
        hash: 'e',
      },
      { slug: 'voxtral-tts-26-03', ids: ['voxtral-mini-tts-2603'], hash: 'f' },
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
    const glm = byId.get('zai-glm-5-2')
    expect(glm?.kind === 'tokens' && glm.rates.output_tokens).toBe(0.9 / 1e6)
    expect(byId.get('mistral-ocr-latest')?.kind).toBe('unit')
    expect(byId.get('voxtral-mini-2602')?.kind).toBe('unit')
    expect(byId.has('mistral-ocr-4-0')).toBe(false)
    expect(byId.has('voxtral-mini-realtime-2602')).toBe(false)
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

describe('mistral model page modalities', () => {
  const parse = (...blocks: Array<Array<unknown>>) =>
    parseMistralPageModalities(mistralModelPage(['m-1'], blocks))
  const base = [tip('Text input'), tip('Text output')]

  it('reads the tooltips of the Modalities block', () => {
    expect(
      parse([tip('Image input'), tip('Text input'), tip('Text output')]),
    ).toEqual({ input: ['text', 'image'], output: ['text'] })
    expect(parse([tip('Audio input'), tip('Text output')])).toEqual({
      input: ['audio'],
      output: ['text'],
    })
    // The side is matched whatever its case.
    expect(
      parse([tip('Text Input'), tip('Image input'), tip('Text OUTPUT')]),
    ).toEqual({ input: ['text', 'image'], output: ['text'] })
    // A reasoning marker is not a medium; the page's "Max output" span is
    // outside the block.
    expect(parse([...base, tip('Reasoning output')])).toEqual({
      input: ['text'],
      output: ['text'],
    })
    // A label served as its own lazy row.
    expect(
      parseMistralPageModalities(
        mistralModelPage(
          ['m-1'],
          [
            [
              tip('Text input'),
              [
                '$',
                '$L4f',
                'k',
                {
                  children: [['$', '$L50', null, { asChild: true }], '$Lc0'],
                },
              ],
            ],
          ],
          { c0: ['$', '$L51', null, { children: 'Text output' }] },
        ),
      ),
    ).toEqual({ input: ['text'], output: ['text'] })
    // A tooltip that gains a prop or a key is still a tooltip.
    expect(
      parse([
        ...base,
        tip('Image input', { side: 'top' }),
        [
          '$',
          '$L4f',
          'audio',
          {
            children: [
              ['$', '$L50', null, { asChild: true }],
              ['$', '$L51', 'k1', { children: 'Audio input' }],
            ],
          },
        ],
      ]),
    ).toEqual({ input: ['text', 'image', 'audio'], output: ['text'] })
  })

  it.each([
    ['an unknown medium', tip('Hologram input')],
    ['a two-word medium', tip('Point cloud input')],
    ['a medium with a digit', tip('3D input')],
    ['a hyphenated medium', tip('3D-mesh input')],
    ['a plural', tip('Images input')],
    ['a reworded label', tip('Input: Image')],
    ['a label with no side', tip('Accepts images')],
    ['an empty tooltip', tip('')],
    ['a tooltip that is not text', tip(['$', 'b', null, { children: 'x' }])],
    ['reasoning as an input', tip('Reasoning input')],
  ])('reads nothing when the block holds %s', (_name, extra) => {
    expect(parse([...base, extra])).toBeNull()
  })

  // A tooltip the walk cannot reach must not be dropped and the rest kept.
  const image = tip('Image input')
  const el = (tag: string, props: object) => ['$', tag, null, props]
  const trigger = (asChild: unknown) =>
    el('$L4f', {
      children: [
        el('$L50', asChild === undefined ? {} : { asChild }),
        el('$L51', { children: 'Image input' }),
      ],
    })
  it.each([
    ['a reference with no row', '$Lnope'],
    ['a tooltip in a Suspense', el('$Sreact.suspense', { children: '$Lc1' })],
    ['a tooltip under a `content` prop', el('$L60', { content: image })],
    ['a tooltip under a `fallback` prop', el('div', { fallback: image })],
    ['object-valued children', el('div', { children: { nested: image } })],
    ['a trigger with no asChild', trigger(undefined)],
    ['a trigger with asChild "true"', trigger('true')],
    ['a lone icon', el('svg', { 'aria-label': 'Image input' })],
    ['text', 'Image input'],
  ])('reads nothing when the block holds %s', (_name, extra) => {
    expect(
      parseMistralPageModalities(
        mistralModelPage(['m-1'], [[...base, extra]], { c1: image }),
      ),
    ).toBeNull()
  })

  it('follows a reference to a tooltip, and reads through plain wrappers', () => {
    const full = { input: ['text', 'image'], output: ['text'] }
    for (const extra of ['$Lc1', [[image]], el('div', { children: [image] })]) {
      expect(
        parseMistralPageModalities(
          mistralModelPage(['m-1'], [[...base, extra]], { c1: image }),
        ),
      ).toEqual(full)
    }
    // The arrows between the two sides are not tooltips.
    const arrows = el('div', {
      className: 'flex',
      children: [el('svg', {}), el('svg', {})],
    })
    expect(
      parse([tip('Text input'), image, arrows, tip('Text output')]),
    ).toEqual(full)
  })

  it('reads nothing from one side, no block, or blocks that differ', () => {
    expect(parse([tip('Text input'), tip('Image input')])).toBeNull()
    expect(parse([tip('Text input'), tip('Reasoning output')])).toBeNull()
    expect(parse()).toBeNull()
    expect(parseMistralPageModalities('<h1>Mistral Medium</h1>')).toBeNull()
    // The page renders the block once per layout; both must agree, so a
    // second model's block cannot be merged in.
    expect(parse(base, base)).toEqual({ input: ['text'], output: ['text'] })
    expect(parse(base, [tip('Audio input'), tip('Audio output')])).toBeNull()
    // Tooltips outside a Modalities block are not read.
    expect(
      parseMistralPageModalities(
        `<script>self.__next_f.push([1,${JSON.stringify(
          `1:${JSON.stringify(base)}\n`,
        )}])</script>`,
      ),
    ).toBeNull()
  })

  it('refuses a poll in which no model page states modalities', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      const href = String(url)
      const body = href.endsWith('/pricing')
        ? PAGE
        : href.endsWith('/changelogs')
          ? ''
          : mistralModelPage([href.slice(href.lastIndexOf('/') + 1)], [])
      return Promise.resolve(new Response(body))
    }) as typeof fetch
    try {
      await expect(mistralModelPricing()).rejects.toThrow(
        /mistral model pages: 0 of \d+ state modalities/,
      )
    } finally {
      globalThis.fetch = original
    }
  })

  it('drops an API id two pages state differently', () => {
    const text = { input: ['text'], output: ['text'] }
    const vision = { input: ['text', 'image'], output: ['text'] }
    const byId = indexMistralModalities([
      { slug: 'a-1', ids: ['a-1', 'a-latest'], hash: 'h1', modalities: text },
      { slug: 'a-2', ids: ['a-2', 'a-latest'], hash: 'h2', modalities: vision },
      { slug: 'b-1', ids: ['b-1'], hash: 'h3', modalities: null },
    ])
    expect([...byId.keys()]).toEqual(['a-1', 'a-2'])
    expect(byId.get('a-2')).toEqual({
      modalities: vision,
      url: 'https://docs.mistral.ai/models/a-2',
      hash: 'h2',
    })
  })
})

describe('mistral model page price and max output', () => {
  const widget = {
    type: 'custom',
    free: false,
    input: [
      { type: 'range', price: 0.004, denominator: '/Min' },
      { type: 'flat', price: 0.1, denominator: '/M Tokens' },
    ],
    output: [{ type: 'range', price: 0.4, denominator: '/M Tokens' }],
  }
  const page = (extra: Record<string, unknown>) =>
    mistralModelPage(['voxtral-small-2507'], [[tip('Text input')]], extra)

  it('keeps native OCR annotated-page pricing distinct from ordinary pages', () => {
    // OCR 4.1's source widget names both denominators; numbers here are synthetic.
    const ocr = {
      type: 'custom',
      free: false,
      input: [
        { type: 'flat', price: 7, denominator: '/1000 Pages' },
        { type: 'flat', price: 11, denominator: '/1000 Annotated Pages' },
      ],
      output: [],
    }
    expect(parseMistralPagePrice(page({ a1: ocr }))).toEqual({
      kind: 'unit',
      meters: [
        { param: 'pages', rate: 7 / 1000 },
        { param: 'annotated_pages', rate: 11 / 1000, default: 0 },
      ],
    })
    expect(() =>
      parseMistralPagePrice(
        page({
          a1: {
            ...ocr,
            input: [
              ocr.input[0],
              {
                type: 'flat',
                originalPrice: 11,
                denominator: '/1000 Annotated Pages',
              },
            ],
          },
        }),
      ),
    ).toThrow('unreadable amount')
    expect(() =>
      parseMistralPagePrice(
        page({
          a1: {
            ...ocr,
            input: [
              ocr.input[0],
              { type: 'flat', price: -1, denominator: '/1000 Annotated Pages' },
            ],
          },
        }),
      ),
    ).toThrow('negative amount')
  })

  it('reads mixed units and uses the current widget price', () => {
    expect(parseMistralPagePrice(page({ a1: widget }))).toEqual({
      kind: 'tokens',
      rates: {
        audio_minutes: 0.004,
        input_tokens: 0.1 / 1e6,
        output_tokens: 0.4 / 1e6,
      },
    })
    const card = mistralRateCard(
      parseMistralPagePrice(page({ a1: widget })) ?? {
        kind: 'tokens',
        rates: {},
      },
      {
        url: 'https://docs.mistral.ai/models/voxtral-small-25-07',
        hash: 'c'.repeat(64),
        extractedAt: '2026-10-08T00:00:00.000Z',
      },
    )
    expect(card).not.toBeNull()
    if (!card) return
    expect(
      price(card, {}, { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ).toBeCloseTo(0.5, 9)
    expect(
      price(
        card,
        {},
        {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          audio_minutes: 2,
        },
      ),
    ).toBeCloseTo(0.508, 9)
    expect(
      parseMistralPagePrice(
        page({
          a3: {
            type: 'custom',
            free: false,
            input: [
              {
                price: 0.68,
                originalPrice: 1.36,
                denominator: '/M Tokens',
                label: 'Input',
              },
              {
                price: 0.07,
                originalPrice: 0.14,
                denominator: '/M Tokens',
                label: 'Cached input',
              },
            ],
            output: [
              {
                price: 2.09,
                originalPrice: 4.18,
                denominator: '/M Tokens',
                label: 'Output',
              },
            ],
          },
        }),
      ),
    ).toEqual({
      kind: 'tokens',
      rates: {
        input_tokens: 0.68 / 1e6,
        cache_read_tokens: 0.07 / 1e6,
        output_tokens: 2.09 / 1e6,
      },
    })
  })

  it('rejects a missing current widget price rather than using originalPrice', () => {
    expect(() =>
      parseMistralPagePrice(
        page({
          a1: {
            type: 'custom',
            free: false,
            input: [{ originalPrice: 9, denominator: '/M Tokens' }],
            output: [{ price: 4, denominator: '/M Tokens' }],
          },
        }),
      ),
    ).toThrow(/unreadable amount/)
  })

  it('stores no card for a free widget and throws when widgets disagree', () => {
    expect(
      parseMistralPagePrice(
        page({
          a1: { type: 'flat', free: true, price: 0, denominator: '/M Tokens' },
        }),
      ),
    ).toBeNull()
    expect(() =>
      parseMistralPagePrice(
        page({
          a1: widget,
          a2: {
            type: 'custom',
            free: false,
            input: [{ price: 1, denominator: '/M Tokens' }],
            output: [{ price: 2, denominator: '/M Tokens' }],
          },
        }),
      ),
    ).toThrow(/widgets disagree/)
  })

  it('reads the Max output stat as 1024-based tokens', () => {
    const stat = (label: string, value: string) => [
      [
        '$',
        'span',
        null,
        {
          className: 'uppercase',
          children: ['$undefined', label],
        },
      ],
      [
        '$',
        'div',
        null,
        {
          className: 'text-lg font-bold font-mono text-primary-soft',
          children: value,
        },
      ],
    ]
    expect(
      parseMistralPageMaxOutput(page({ aa: stat('Max output', '128k') })),
    ).toBe(128 * 1024)
    // The context stat is not a max-output cap.
    expect(
      parseMistralPageMaxOutput(page({ aa: stat('Context', '1M') })),
    ).toBeNull()
    expect(
      parseMistralPageMaxOutput(
        page({
          aa: stat('Max output', '128k'),
          ab: stat('Max output', '256k'),
        }),
      ),
    ).toBeNull()
  })

  it('matches one index slug and no more', () => {
    const slugs = parseMistralModelIndex(
      '<a href="/models/overview">o</a><a href="/models/voxtral-small-25-07">v</a><a href="/models/leanstral-1-5">l</a><a href="/models/zai-glm-5-2">g</a> /models/page-abc',
    )
    const set = new Set(slugs)
    expect(slugs).toEqual([
      'voxtral-small-25-07',
      'leanstral-1-5',
      'zai-glm-5-2',
    ])
    expect(mistralIndexSlugFor('voxtral-small-2507', set)).toBe(
      'voxtral-small-25-07',
    )
    expect(mistralIndexSlugFor('labs-leanstral-1-5', set)).toBe('leanstral-1-5')
    expect(mistralIndexSlugFor('zai-glm-5-2', set)).toBe('zai-glm-5-2')
    expect(mistralIndexSlugFor('mistral-medium-2604', set)).toBeNull()
    expect(mistralIndexSlugFor('magistral-medium-latest', set)).toBeNull()
  })
})

describe('mistral alias facts', () => {
  it('copies one agreed fact onto mutual aliases and skips a conflict', () => {
    const source = {
      derivation: 'docs-derived' as const,
      sourceUrl: 'https://docs.mistral.ai/models/mistral-small-4-0-26-03',
    }
    const models = [
      {
        rawId: 'mistral-small-latest',
        modalities: { input: ['text'], output: ['text'] },
        maxOutput: 131072,
        factSources: { modalities: source, maxOutput: source },
      },
      { rawId: 'mistral-vibe-cli-fast' },
      {
        rawId: 'left',
        pricing: { price: 1 },
      },
      {
        rawId: 'right',
        pricing: { price: 2 },
      },
      { rawId: 'neither' },
    ]
    copyMistralAliasFacts(
      models,
      new Map([
        ['mistral-small-latest', ['mistral-vibe-cli-fast']],
        ['mistral-vibe-cli-fast', ['mistral-small-latest']],
        ['left', ['right', 'neither']],
        ['right', ['left']],
        ['neither', ['left']],
      ]),
    )
    expect(models[1]).toMatchObject({
      modalities: { input: ['text'], output: ['text'] },
      maxOutput: 131072,
      factSources: { modalities: source, maxOutput: source },
    })
    expect(models[4]?.pricing).toBeUndefined()
  })
})

describe('usdExpr', () => {
  it('throws rather than compose a non-USD card and drop its currency', async () => {
    const { compileTokenCard } = await import('@modelschemas/rate-card')
    const { usdExpr } = await import('./mistral-pricing.ts')
    const source = {
      url: 'https://example.test/pricing',
      hash: 'a'.repeat(64),
      extractedAt: '2026-10-07T00:00:00Z',
    }
    const usd = compileTokenCard({ input_tokens: 1e-6 }, [], source)
    const yuan = compileTokenCard({ input_tokens: 1e-6 }, [], source, {
      currency: 'CNY',
    })
    if (!usd || !yuan) throw new Error('did not compile')
    expect(usdExpr(usd)).toBe(usd.price)
    expect(() => usdExpr(yuan)).toThrow('cannot extend a CNY card')
  })
})
