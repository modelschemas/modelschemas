import { describe, expect, it } from 'vitest'

import { parseLedger } from '../src/lib/completeness.ts'
import {
  classify,
  compare,
  counterparts,
  formatProvider,
  formatTable,
  main,
  matchModels,
} from './compare-models-dev.ts'
import type { OurRow, TheirCatalog, TheirModel } from './compare-models-dev.ts'

// Hand-written; not a copy of models.dev data.
const their = (id: string, extra: Partial<TheirModel> = {}): TheirModel => ({
  id,
  reasoning: false,
  tool_call: true,
  modalities: { input: ['text'], output: ['text'] },
  limit: { context: 128000, output: 4096 },
  ...extra,
})

const catalog = (...models: Array<TheirModel>) => ({
  models: Object.fromEntries(models.map((model) => [model.id, model])),
})

const ours = (rawId: string, extra: Partial<OurRow> = {}): OurRow => ({
  provider: 'acme',
  rawId,
  activity: 'chat',
  ...extra,
})

const usdCard = (base: Record<string, number>) => ({
  price: { var: 'input_tokens' },
  tables: { rate: { base } },
  source: { url: 'https://acme.example/pricing' },
})

describe('counterparts', () => {
  const theirs: TheirCatalog = {
    xai: catalog(),
    acme: catalog(),
    perplexity: catalog(),
    'perplexity-agent': catalog(),
    volcengine: catalog(),
  }

  it('maps a renamed provider, and keeps an identical id', () => {
    expect(counterparts('grok', theirs)).toEqual(['xai'])
    expect(counterparts('acme', theirs)).toEqual(['acme'])
  })

  it('maps one of ours onto both halves of a provider they split', () => {
    expect(counterparts('perplexity', theirs)).toEqual([
      'perplexity-agent',
      'perplexity',
    ])
  })

  it('reports no counterpart rather than a look-alike', () => {
    expect(counterparts('byteplus', theirs)).toEqual([])
    expect(counterparts('gemini', theirs)).toEqual([])
  })
})

describe('matchModels', () => {
  const index = (...models: Array<TheirModel>) =>
    new Map(models.map((model) => [model.id, { provider: 'acme', model }]))
  const how = (rows: Array<OurRow>, ...models: Array<TheirModel>) => {
    const { matches, unmatched } = matchModels(rows, index(...models))
    return {
      matches: matches.map((m) => `${m.row.rawId}→${m.theirs.id} ${m.how}`),
      unmatched: unmatched.map((row) => row.rawId),
    }
  }

  it('matches the exact raw id first', () => {
    expect(
      how(
        [ours('gpt-5', { aliases: ['gpt-5-2025'] })],
        their('gpt-5'),
        their('gpt-5-2025'),
      ),
    ).toEqual({ matches: ['gpt-5→gpt-5 exact'], unmatched: [] })
  })

  it('then a stored alias', () => {
    expect(
      how(
        [ours('claude-x-20250101', { aliases: ['claude-x'] })],
        their('claude-x'),
      ),
    ).toEqual({ matches: ['claude-x-20250101→claude-x alias'], unmatched: [] })
  })

  it('then case and dots-vs-hyphens', () => {
    expect(how([ours('Org/Model-V3.1')], their('org/model-v3-1'))).toEqual({
      matches: ['Org/Model-V3.1→org/model-v3-1 normalised'],
      unmatched: [],
    })
  })

  it('never matches a sibling or a dated variant', () => {
    expect(
      how(
        [ours('gpt-5')],
        their('gpt-5-mini'),
        their('gpt-5-pro'),
        their('gpt-5-2025-08-07'),
      ),
    ).toEqual({ matches: [], unmatched: ['gpt-5'] })
  })

  it('leaves an ambiguous normalised id unmatched', () => {
    expect(
      how([ours('m-1.5')], their('M-1.5'), their('m-1-5')).matches,
    ).toEqual([])
    expect(how([ours('m-1.5'), ours('M-1-5')], their('m-1-5')).matches).toEqual(
      [],
    )
  })

  it('claims each of their models once', () => {
    expect(how([ours('a'), ours('b', { aliases: ['a'] })], their('a'))).toEqual(
      { matches: ['a→a exact'], unmatched: ['b'] },
    )
  })
})

describe('classify', () => {
  it('names each of the five outcomes', () => {
    expect(classify(1, 1)).toBe('agree')
    expect(classify('text', 'image,text')).toBe('disagree')
    expect(classify(true, undefined)).toBe('onlyOurs')
    expect(classify(undefined, false)).toBe('onlyTheirs')
    expect(classify(undefined, undefined)).toBe('neither')
  })

  it('counts a differently rounded label apart from exact and from wrong', () => {
    const rounding = { rounding: true }
    expect(classify(128000, 131072, rounding)).toBe('agreeRounding')
    expect(classify(1048576, 1000000, rounding)).toBe('agreeRounding')
    expect(classify(200000, 200000, rounding)).toBe('agree')
    expect(classify(400000, 272000, rounding)).toBe('disagree')
    // Only limits round; a price 2% off is a different price.
    expect(classify(1, 1.02)).toBe('disagree')
  })

  it('does not compare a non-USD price, and never converts it', () => {
    expect(classify('2.1/8.4', '0.3/1.2', { currency: 'CNY' })).toBe('nonUsd')
    expect(classify('0.3/1.2', '0.3/1.2', { currency: 'USD' })).toBe('agree')
    expect(classify(undefined, '0.3/1.2', { currency: 'CNY' })).toBe(
      'onlyTheirs',
    )
  })
})

describe('compare', () => {
  const rows: Array<OurRow> = [
    ours('full', {
      contextWindow: 131072,
      maxOutput: 8192,
      modalities: { input: ['text', 'pdf'], output: ['text'] },
      pricing: usdCard({
        input_tokens: 1.25e-6,
        output_tokens: 1e-5,
        cache_read_tokens: 1.25e-7,
      }),
      capabilities: ['tools', 'temperature'],
      reasoning: { mode: 'effort', efforts: ['low', 'high'] },
    }),
    ours('bare'),
    ours('yuan', {
      pricing: {
        ...usdCard({ prompt: 2.1e-6, completion: 8.4e-6 }),
        price: { currency: ['CNY', { var: 'input_tokens' }] },
      },
    }),
    ours('borrowed', {
      pricing: {
        ...usdCard({ input_tokens: 1e-6, output_tokens: 2e-6 }),
        source: { url: 'https://models.dev/api.json' },
      },
    }),
    ours('ours-only'),
    ours('speaker', { activity: 'tts' }),
    ours('grok-1', { provider: 'grok' }),
    ours('lonely', { provider: 'byteplus' }),
    ours('image-only', { provider: 'studio', activity: 'image' }),
  ]
  const priced = { cost: { input: 1.25, output: 10, cache_read: 0.125 } }
  const theirs: TheirCatalog = {
    acme: catalog(
      their('full', {
        ...priced,
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['high', 'low'] }],
        temperature: false,
        modalities: { input: ['text', 'pdf'], output: ['text'] },
        release_date: '2026-01-01',
        family: 'full',
      }),
      their('bare', priced),
      their('yuan', priced),
      their('borrowed', priced),
      their('theirs-only'),
      their('speaker'),
      their('text-embed-1'),
      their('painter', { modalities: { input: ['text'], output: ['image'] } }),
    ),
    xai: catalog(their('grok-1')),
    volcengine: catalog(their('lonely')),
  }
  const ledger = parseLedger('- acme: maxOutput — not published\n')
  const report = compare(rows, theirs, ledger, new Date(0))
  const acme = report.providers.find((p) => p.provider === 'acme')
  const cell = (
    model: string,
    fact: 'priced' | 'contextWindow' | 'maxOutput',
  ) => acme?.models.find((m) => m.ours === model)?.facts[fact]

  it('scopes to our chat rows and lists both sides’ leftovers', () => {
    expect(report.providers.map((p) => p.provider)).not.toContain('studio')
    expect(acme).toMatchObject({
      chat: 5,
      matched: 4,
      unmatchedOurs: ['ours-only'],
      notListed: ['theirs-only'],
      listedNotChat: ['speaker'],
    })
    expect(report.notInModelsDev).toEqual(['byteplus'])
    expect(report.providers.find((p) => p.provider === 'grok')?.theirs).toEqual(
      ['xai'],
    )
  })

  it('classifies each fact of a matched pair, keeping both values', () => {
    const full = acme?.models.find((m) => m.ours === 'full')?.facts
    expect(full).toMatchObject({
      contextWindow: { status: 'agreeRounding', ours: 131072, theirs: 128000 },
      maxOutput: { status: 'disagree', ours: 8192, theirs: 4096 },
      // Their `pdf` and our `file` are one modality.
      inputModalities: { status: 'agree', ours: 'file,text' },
      priced: { status: 'agree', ours: '1.25/10', theirs: '1.25/10' },
      cacheRead: { status: 'agree', ours: 0.125 },
      cacheWrite: { status: 'neither' },
      tools: { status: 'agree' },
      // No acme row lists `structured_outputs`, so its absence says nothing.
      structuredOutput: { status: 'neither' },
      reasoning: { status: 'agree' },
      reasoningOptions: { status: 'agree', ours: 'effort:high,low' },
      temperature: { status: 'disagree', ours: true, theirs: false },
    })
    expect(acme?.noField).toMatchObject({
      release_date: 1,
      family: 1,
      knowledge: 0,
    })
  })

  it('reports a non-USD card as held but not compared', () => {
    expect(cell('yuan', 'priced')).toEqual({
      status: 'nonUsd',
      ours: '2.1/8.4',
      theirs: '1.25/10',
    })
  })

  it('does not count a price we took from models.dev as ours', () => {
    expect(cell('borrowed', 'priced')?.status).toBe('onlyTheirs')
  })

  it('marks a gap the ledger explains, and only that one', () => {
    expect(cell('bare', 'maxOutput')).toEqual({
      status: 'onlyTheirs',
      theirs: 4096,
      ledgered: true,
    })
    expect(cell('bare', 'contextWindow')).toEqual({
      status: 'onlyTheirs',
      theirs: 128000,
    })
    expect(acme?.silent).toEqual(['maxOutput'])
    expect(acme?.facts.maxOutput.ledgered).toBe(3)
  })

  it('states parity both ways, with and without ledgered facts', () => {
    const { headline, headlineExcludingLedgered: scored } = report
    expect(headline.matched).toBe(5)
    expect(headline.oursOfTheirs.have).toBe(headline.theirsOfOurs.have)
    expect(headline.oursOfTheirs.of).toBeGreaterThan(headline.oursOfTheirs.have)
    // The ledgered fact leaves both sides of the ratio: 3 gaps and 1 held.
    expect(headline.oursOfTheirs.of - scored.oursOfTheirs.of).toBe(4)
    expect(headline.oursOfTheirs.have - scored.oursOfTheirs.have).toBe(1)
    expect(scored.oursOfTheirs.ratio).toBeGreaterThan(
      headline.oursOfTheirs.ratio,
    )
  })

  it('prints the table worst first with the caveat, and a provider view', () => {
    const table = formatTable(report).split('\n')
    expect(table[1]).toMatch(/^acme\s+acme\s+5\s+4\s+1\s+1\s/)
    expect(table.join('\n')).toMatch(/byteplus\s+not in models\.dev/)
    expect(table.join('\n')).toContain('3/4*')
    expect(table.at(-1)).toContain('not ground truth')
    const detail = formatProvider(report.providers[0]!)
    expect(detail).toContain('behind    bare: theirs 128000')
    expect(detail).toContain('disagree  full: ours 8192 · theirs 4096')
  })
})

describe('what counts as a value', () => {
  const rows: Array<OurRow> = [
    ours('thinker', { capabilities: ['reasoning'] }),
    ours('tooler', { capabilities: ['tools', 'reasoning'] }),
    ours('empty', { capabilities: [] }),
    ours('jingle', {
      pricing: {
        price: 0.04,
        tables: {},
        source: { url: 'https://acme.example/pricing' },
      },
    }),
    ours('translator', { pricing: usdCard({ audio_tokens: 3.5e-6 }) }),
    ours('effortless', { reasoning: { mode: 'effort' } }),
    ours('notext', { modalities: { input: ['image'], output: ['text'] } }),
    ours('vendor.m', { aliases: ['au.vendor.m-v1', 'us.vendor.m-v1'] }),
  ]
  const theirs: TheirCatalog = {
    acme: catalog(
      their('thinker', { temperature: true, structured_output: true }),
      their('tooler'),
      their('empty'),
      their('jingle', { cost: { input: 1, output: 2 } }),
      their('translator', { cost: { input: 1, output: 2 } }),
      their('effortless', {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      }),
      their('notext'),
      their('au.vendor.m-v1'),
      their('vendor.m-v1'),
      their('us.vendor.m-v1'),
    ),
  }
  const report = compare(rows, theirs, new Map(), new Date(0))
  const acme = report.providers[0]!
  const facts = (model: string) =>
    acme.models.find((m) => m.ours === model)?.facts

  it('reads a missing flag as false only when the provider emits that flag', () => {
    // `tools` appears on a sibling row, so its absence here is a held false.
    expect(facts('thinker')?.tools).toEqual({
      status: 'disagree',
      ours: false,
      theirs: true,
    })
    // No acme row ever lists these two: unknown, so we are behind.
    expect(facts('thinker')?.temperature.status).toBe('onlyTheirs')
    expect(facts('thinker')?.structuredOutput.status).toBe('onlyTheirs')
    expect(facts('thinker')?.reasoning.ours).toBe(true)
  })

  it('reads an empty capability list as unknown', () => {
    expect(facts('empty')?.tools).toEqual({
      status: 'onlyTheirs',
      theirs: true,
    })
    expect(facts('empty')?.reasoning.status).toBe('onlyTheirs')
  })

  it('counts a per-request or audio-token card as priced, uncompared', () => {
    const nonToken = {
      status: 'nonToken',
      ours: 'non-token card',
      theirs: '1/2',
    }
    expect(facts('jingle')?.priced).toEqual(nonToken)
    expect(facts('translator')?.priced).toEqual(nonToken)
    expect(acme.facts.priced.nonToken).toBe(2)
  })

  it('does not hold reasoning options for an effort mode with no names', () => {
    expect(facts('effortless')?.reasoningOptions).toEqual({
      status: 'onlyTheirs',
      theirs: 'effort:high,low',
    })
  })

  it('counts models.dev zero rates, discloses them, and can leave them out', () => {
    expect(report.zeroRates).toEqual({ priced: 1, cacheRead: 1, cacheWrite: 1 })
    expect(report.note).toContain(
      'price 0/0 on 1 matched models, cache_read 0 on 1, cache_write 0 on 1',
    )
    const { headline, headlineExcludingZeroRates: nonZero } = report
    expect(headline.oursOfTheirs.of - nonZero.oursOfTheirs.of).toBe(3)
    expect(nonZero.oursOfTheirs.have).toBe(headline.oursOfTheirs.have)
    expect(formatTable(report)).toContain('excluding models.dev zero rates:')
  })

  it('prefers the model itself to a regional profile of it', () => {
    expect(acme.models.find((m) => m.ours === 'vendor.m')).toMatchObject({
      theirs: 'acme/vendor.m-v1',
      how: 'alias',
    })
    // The regional ids are aliases of a chat row, not rows we hold as non-chat.
    expect(acme.aliasOfChatRow).toEqual(['au.vendor.m-v1', 'us.vendor.m-v1'])
    expect(acme.listedNotChat).toEqual([])
    expect(acme.notListed).toEqual([])
  })

  it('keeps the rows whose input modalities lack text visible', () => {
    expect(report.inputWithoutText).toEqual({
      total: 1,
      byProvider: { acme: 1 },
    })
    expect(formatTable(report)).toContain(
      'input modalities lack "text": 1 (acme 1)',
    )
    // Compared as stored, not repaired.
    expect(facts('notext')?.inputModalities).toMatchObject({
      status: 'disagree',
      ours: 'image',
      theirs: 'text',
    })
  })
})

describe('main', () => {
  it('rejects a --min outside 0..1 before fetching anything', async () => {
    await expect(main(['--min', '2'])).rejects.toThrow('--min')
  })
})
