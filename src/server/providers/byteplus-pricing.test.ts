import { describe, expect, it } from 'vitest'

import { price, priceDetailed } from '@modelschemas/rate-card'

import {
  byteplusRatesFor,
  compileSeedanceCard,
  parseByteplusImages,
  parseByteplusPricing,
  parseByteplusVideo,
  parseSeedanceGeometry,
} from './byteplus-pricing.ts'
import type { ByteplusDoc } from './byteplus-pricing.ts'

function cell(id: string, text: string) {
  return {
    ops: [{ insert: '*', attributes: { lmkr: '1' } }, { insert: `${text}\n` }],
    zoneId: id,
    zoneType: 'Z',
  }
}

/** Chat-table header: model, tier, input, audio, cache storage, cache hit, audio cache, output. */
const CHAT_HEADERS = [
  'Model ID',
  'Pricing tiers (K tokens)',
  'Input (non-audio) (USD/M tokens)',
  'Input (audio) (USD/M tokens)',
  'Cache-storage (USD/M tokens/Hour)',
  'Cache-hit input (non-audio) (USD/M tokens)',
  'Cache-hit input (audio) (USD/M tokens)',
  'Output (USD/M tokens)',
]

/** Page document of `tables`, each a header row then body rows. */
function doc(...tables: Array<Array<Array<string>>>): ByteplusDoc {
  const data: ByteplusDoc['data'] = { '0': { ops: [] } }
  tables.forEach((body, t) => {
    data['0']?.ops?.push({
      insert: '*',
      attributes: { aceTable: `rows${t} cols${t}` },
    })
    data[`rows${t}`] = {
      ops: body.map((_, index) => ({ insert: { id: `t${t}r${index}` } })),
      zoneType: 'R',
    }
    data[`cols${t}`] = {
      ops: (body[0] ?? []).map((_, index) => ({
        insert: { id: `t${t}c${index}` },
      })),
      zoneType: 'C',
    }
    body.forEach((cells, row) => {
      cells.forEach((text, column) => {
        const id = `xt${t}r${row}xt${t}c${column}`
        data[id] = cell(id, text)
      })
    })
  })
  return { data }
}

describe('byteplus pricing page', () => {
  it('reads standard token rates, tiers, and a dated catalog suffix', () => {
    const rates = parseByteplusPricing(
      doc([
        CHAT_HEADERS,
        [
          'dola-seed-2-1-turbo',
          'Prompt length [0, 256]',
          '0.5',
          '-',
          '0.0083',
          '0.1',
          '-',
          '2.5',
        ],
        [
          'seed-2-0-pro-260328',
          'Prompt length [0, 128]',
          '0.50',
          '-',
          '0.0083',
          '0.10',
          '-',
          '3.00',
        ],
        [
          '',
          'Prompt length (128, 256]',
          '1.00',
          '-',
          '0.0083',
          '0.20',
          '-',
          '6.00',
        ],
        [
          'seed-2-0-lite-260428',
          'Prompt length [0, 128]',
          '0.25',
          '3.75',
          '0.0083',
          '0.05',
          '0.75',
          '2.00',
        ],
        [
          'deepseek-v4-1-flash-260910',
          'Off-peak hours',
          '0.15',
          '-',
          '0.0083',
          '0.003',
          '-',
          '0.60',
        ],
        ['', 'Peak hours', '0.30', '-', '0.0083', '0.006', '-', '1.20'],
        ['glm-5-2-260617', '-', '1.4', '-', '0.0083', '0.26', '-', '4.4'],
      ]),
    )
    expect(rates.get('glm-5-2-260617')).toEqual({
      base: {
        input_tokens: 1.4e-6,
        cache_read_tokens: 0.26e-6,
        output_tokens: 4.4e-6,
      },
      tiers: [],
    })
    expect(rates.get('seed-2-0-lite-260428')?.base.audio_tokens).toBe(3.75e-6)
    expect(rates.get('seed-2-0-pro-260328')?.tiers).toEqual([
      {
        minPromptTokens: 128_000,
        rates: {
          input_tokens: 1 / 1e6,
          cache_read_tokens: 0.2 / 1e6,
          output_tokens: 6 / 1e6,
        },
      },
    ])
    // Cache storage is per hour, so it is not a lever.
    expect(rates.get('glm-5-2-260617')?.base).not.toHaveProperty(
      'cache_storage',
    )
    // Peak and off-peak have no time lever.
    expect(rates.has('deepseek-v4-1-flash-260910')).toBe(false)
    expect(
      byteplusRatesFor('dola-seed-2-1-turbo-260628', rates)?.base.input_tokens,
    ).toBe(0.5e-6)
    expect(byteplusRatesFor('seed-translation-250915', rates)).toBeUndefined()
  })
})

const SOURCE = {
  url: 'https://docs.byteplus.com/en/docs/ModelArk/1544106',
  hash: 'a'.repeat(64),
  extractedAt: '2026-10-02T00:00:00Z',
}

/** Rate cells as the live page words them (read 2026-10-02). */
const VIDEO_TABLE = [
  [
    'Model ID',
    'Online inference (USD / M tokens)',
    'Offline inference (USD / M tokens)',
  ],
  [
    'dreamina-seedance-2-5-260628 Pricing varies based on output video resolution and whether the input includes video.',
    'For 480p and 720p outputs: Input without video: 10.70 Input with video: 6.40 For 1080p outputs: Input without video: 11.7 Input with video: 7.0',
    'Not supported yet',
  ],
  [
    'dreamina-seedance-2-0-fast-260128 Pricing varies based on whether the input includes video.',
    'For 480p and 720p outputs: Input without video: (Original) 5.6 Time limited 25% off Input with video: (Original) 3.3 Time limited 25% off',
    'Not supported yet',
  ],
  [
    'seedance-1-5-pro-251215 Pricing varies based on whether the output includes audio',
    'Video with audio: 2.4 Video without audio: 1.2',
    'Video with audio: 1.2 Video without audio: 0.6',
  ],
  ['seedance-1-0-pro-250528', '2.5', '1.25'],
  ['seedance-9-unknown-261231', 'Contact sales', 'Not supported yet'],
]

const IMAGE_TABLE = [
  [
    'Model ID',
    'Input image price (USD / image)',
    'Output image price (USD / image)',
  ],
  [
    'dola-seedream-5-0-pro-260628 Pricing varies by image generation scenario.',
    'First image: Free From the 2nd image: 0.003',
    'Single image generation: ≤ 2.61 million pixels (1.5K or lower): 0.045',
  ],
  ['seedream-4-5-251128', 'Free', '0.04'],
]

describe('byteplus video and image tables', () => {
  const page = doc(VIDEO_TABLE, IMAGE_TABLE)
  const video = parseByteplusVideo(page)

  it('reads list prices per tier, resolution, and variant', () => {
    expect(video.get('dreamina-seedance-2-0-fast-260128')).toEqual({
      default: {
        '480p': { no_video: 5.6, video: 3.3 },
        '720p': { no_video: 5.6, video: 3.3 },
      },
    })
    // No "For … outputs": one rate whatever the resolution.
    expect(video.get('seedance-1-0-pro-250528')).toEqual({
      default: { '*': { all: 2.5 } },
      flex: { '*': { all: 1.25 } },
    })
    expect(video.has('seedance-9-unknown-261231')).toBe(false)
    expect(parseByteplusImages(page)).toEqual(
      new Map([['seedream-4-5-251128', 0.04]]),
    )
  })

  it('prices billed completion_tokens and refuses what it cannot know', () => {
    const usd = (
      id: string,
      request: Record<string, unknown>,
      usage?: Record<string, unknown>,
    ) => {
      const rates = video.get(id)
      const card = rates && compileSeedanceCard(rates, SOURCE)
      if (!card) throw new Error(`no card for ${id}`)
      return Number(price(card, request, usage).toFixed(4))
    }
    const v25 = 'dreamina-seedance-2-5-260628'
    expect(
      usd(
        v25,
        { resolution: '1080p' },
        { completion_tokens: 1e6, input_video: true },
      ),
    ).toBe(7)
    // Seedance 1.0 Pro usage table: 489600 tokens → 1.22.
    expect(
      usd('seedance-1-0-pro-250528', {}, { completion_tokens: 489_600 }),
    ).toBe(1.224)
    expect(
      usd(
        'seedance-1-5-pro-251215',
        { generate_audio: true, service_tier: 'flex' },
        { completion_tokens: 1e6 },
      ),
    ).toBe(1.2)
    const billed = { completion_tokens: 1e6, input_video: false }
    // No billed count, no stated video input, no audio choice: refuse.
    expect(() => usd(v25, { resolution: '720p' }, {})).toThrow(
      /completion_tokens/,
    )
    expect(() =>
      usd(v25, { resolution: '720p' }, { completion_tokens: 1e6 }),
    ).toThrow(/input_video/)
    expect(() =>
      usd('seedance-1-5-pro-251215', {}, { completion_tokens: 1 }),
    ).toThrow(/generate_audio/)
    // Draft bills at another resolution; flex has no offline column.
    expect(() =>
      usd(v25, { resolution: '1080p', draft: true }, billed),
    ).toThrow(/draft/)
    expect(() =>
      usd(v25, { resolution: '720p', service_tier: 'flex' }, billed),
    ).toThrow(/flex/)
  })
})

/** The tutorial's model and pixel tables as the live page words them. */
const GUIDE = doc(
  [
    [
      'Model name',
      '',
      'Dreamina Seedance 2.0',
      'Dreamina Seedance 2.0 Fast',
      'Seedance 1.0 Pro',
    ],
    [
      'Model ID',
      '',
      'dreamina-seedance-2-0-260128',
      'dreamina-seedance-2-0-fast-260128',
      'seedance-1-0-pro-250528',
    ],
    ['', 'Frame rate', '24 fps', '24 fps', '24 fps'],
  ],
  [
    [
      'Resolution',
      'Aspect ratio',
      'Dreamina Seedance 2.0 series',
      'Seedance 1.0 series',
    ],
    ['720p', '16:9', '1280×720', '1248×704'],
    ['', '4:3', '1112×834', '1120×832'],
    [
      '1080p Dreamina Seedance 2.0 Fast and Dreamina Seedance 2.0 Mini do not support 1080p',
      '16:9',
      '1920×1080',
      '1920×1088',
    ],
    ['4k Only Dreamina Seedance 2.0 supports 4K', '16:9', '3840×2160', ''],
    ['', '4:3', '3326×2494', '-'],
  ],
)

describe('byteplus video generation tutorial', () => {
  const geometry = parseSeedanceGeometry(GUIDE)

  it('reads frame rate and sizes per model, series columns included', () => {
    expect(geometry.get('seedance-1-0-pro-250528')).toEqual({
      fps: 24,
      dims: {
        '720p': {
          '16:9': { w: 1248, h: 704 },
          '4:3': { w: 1120, h: 832 },
        },
        '1080p': { '16:9': { w: 1920, h: 1088 } },
      },
    })
    expect(
      geometry.get('dreamina-seedance-2-0-260128')?.dims['4k']?.['4:3'],
    ).toEqual({ w: 3326, h: 2494 })
  })

  it('labels the estimate, and keeps sizes to the resolutions priced', () => {
    const id = 'dreamina-seedance-2-0-fast-260128'
    const model = geometry.get(id)
    if (!model) throw new Error('no geometry')
    const card = compileSeedanceCard(
      {
        default: {
          '480p': { no_video: 5.6, video: 3.3 },
          '720p': { no_video: 5.6, video: 3.3 },
        },
      },
      SOURCE,
      { model, url: 'https://example.test/guide', hash: 'b'.repeat(64) },
    )
    if (!card) throw new Error('no card')
    // The series column lists 1080p and 4K; Fast prices neither.
    expect(Object.keys(card.tables.pixels ?? {})).toEqual(['720p'])
    // Page: "Dreamina Seedance 2.0 Fast (USD) 0.60 per video" (720p 16:9 5 s).
    const request = { resolution: '720p', ratio: '16:9', duration: 5 }
    const result = priceDetailed(card, request, { input_video: false })
    expect(result.estimated).toEqual(['completion_tokens'])
    expect(result.usd.toFixed(2)).toBe('0.60')
    // Video input carries a minimum-token floor the method does not cover.
    expect(() => priceDetailed(card, request, { input_video: true })).toThrow(
      /estimate_supported/,
    )
  })
})
