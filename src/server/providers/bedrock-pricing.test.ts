import { describe, expect, it } from 'vitest'

import {
  bedrockNameKey,
  lookupBedrockPrice,
  matchBedrockModelId,
  parseBedrockOffer,
  parseBedrockPricingPage,
  BEDROCK_PRICE_LIST_URL,
  BEDROCK_PRICING_PAGE_URL,
} from './bedrock-pricing.ts'

function dimension(usd: string, unit = '1K tokens') {
  return {
    unit,
    beginRange: '0',
    endRange: 'Inf',
    pricePerUnit: { USD: usd },
  }
}

function product(
  usagetype: string,
  inferenceType: string,
  serviceTier: string,
  feature: string,
  model: string,
) {
  return {
    attributes: {
      usagetype,
      inferenceType,
      service_tier: serviceTier,
      feature,
      model,
    },
  }
}

const OFFER = {
  products: {
    kimiIn: product(
      'USE1-moonshotai.kimi-k3-mantle-input-tokens-standard',
      'Input tokens',
      'standard',
      '',
      'Kimi K3',
    ),
    kimiOut: product(
      'USE1-moonshotai.kimi-k3-mantle-output-tokens-standard',
      'Output tokens',
      'standard',
      '',
      'Kimi K3',
    ),
    kimiRead: product(
      'USE1-moonshotai.kimi-k3-mantle-cache-read-tokens-standard',
      'Cache read tokens',
      'standard',
      '',
      'Kimi K3',
    ),
    kimiGlobal: product(
      'USE1-moonshotai.kimi-k3-mantle-input-tokens-global-standard',
      'Input tokens global',
      'global-standard',
      '',
      'Kimi K3',
    ),
    kimiPriority: product(
      'USE1-moonshotai.kimi-k3-mantle-output-tokens-priority',
      'Output tokens priority',
      'priority',
      '',
      'Kimi K3',
    ),
    qwenIn: product(
      'USE1-Qwen3-32B-input-tokens',
      'Input tokens',
      '',
      'On-demand Inference',
      'Qwen3 32B',
    ),
    qwenOut: product(
      'USE1-Qwen3-32B-output-tokens',
      'Output tokens',
      '',
      'On-demand Inference',
      'Qwen3 32B',
    ),
    qwenFlex: product(
      'USE1-Qwen3-32B-input-tokens-flex',
      'Input tokens flex',
      '',
      'On-demand Inference',
      'Qwen3 32B',
    ),
    sonicTextIn: product(
      'USE1-NovaSonic-text-input-tokens',
      'Text Input Token',
      '',
      'On-demand Inference',
      'Nova Sonic',
    ),
    sonicTextOut: product(
      'USE1-NovaSonic-text-output-tokens',
      'Text output token',
      '',
      'On-demand Inference',
      'Nova Sonic',
    ),
    sonicSpeechIn: product(
      'USE1-NovaSonic-speech-input-tokens',
      'Speech Understanding input token',
      '',
      'On-demand Inference',
      'Nova Sonic',
    ),
    sonicSpeechOut: product(
      'USE1-NovaSonic-speech-output-tokens',
      'Speech Understanding output token',
      '',
      'On-demand Inference',
      'Nova Sonic',
    ),
    deepseekIn: product(
      'USE1-deepseek.v3.1-mantle-input-tokens-standard',
      'Input tokens',
      'standard',
      '',
      'DeepSeek V3.1',
    ),
    deepseekOut: product(
      'USE1-deepseek.v3.1-mantle-output-tokens-standard',
      'Output tokens',
      'standard',
      '',
      'DeepSeek V3.1',
    ),
    kimiWrite30: product(
      'USE1-moonshotai.kimi-k3-mantle-cache-write-tokens-30m-standard',
      'Cache write tokens',
      'standard',
      '',
      'Kimi K3',
    ),
    qwenNextIn: product(
      'USE1-qwen.qwen3-next-80b-a3b-instruct-mantle-input-tokens-standard',
      'Input tokens',
      'standard',
      '',
      'Qwen3 Next 80B A3B',
    ),
    qwenNextOut: product(
      'USE1-qwen.qwen3-next-80b-a3b-instruct-mantle-output-tokens-standard',
      'Output tokens',
      'standard',
      '',
      'Qwen3 Next 80B A3B',
    ),
  },
  terms: {
    OnDemand: {
      kimiIn: { t: { priceDimensions: { d: dimension('0.0033000000') } } },
      kimiOut: { t: { priceDimensions: { d: dimension('0.0165000000') } } },
      kimiRead: { t: { priceDimensions: { d: dimension('0.0003300000') } } },
      kimiGlobal: { t: { priceDimensions: { d: dimension('0.0010000000') } } },
      kimiPriority: {
        t: { priceDimensions: { d: dimension('0.0280000000') } },
      },
      qwenIn: { t: { priceDimensions: { d: dimension('0.0001500000') } } },
      qwenOut: { t: { priceDimensions: { d: dimension('0.0006000000') } } },
      qwenFlex: { t: { priceDimensions: { d: dimension('0.0000750000') } } },
      sonicTextIn: { t: { priceDimensions: { d: dimension('0.0000600000') } } },
      sonicTextOut: {
        t: { priceDimensions: { d: dimension('0.0002400000') } },
      },
      sonicSpeechIn: {
        t: { priceDimensions: { d: dimension('0.0034000000') } },
      },
      sonicSpeechOut: {
        t: { priceDimensions: { d: dimension('0.0136000000') } },
      },
      deepseekIn: { t: { priceDimensions: { d: dimension('0.0005500000') } } },
      deepseekOut: { t: { priceDimensions: { d: dimension('0.0022000000') } } },
      kimiWrite30: { t: { priceDimensions: { d: dimension('9.9900000000') } } },
      qwenNextIn: { t: { priceDimensions: { d: dimension('0.0001400000') } } },
      qwenNextOut: { t: { priceDimensions: { d: dimension('0.0014000000') } } },
    },
  },
}

const METER = {
  regions: {
    'US East (N. Virginia)': {
      GEOIN: { price: '2.2000000000' },
      GLOBAL: { price: '0.5000000000' },
    },
  },
}

const PAGE = `
<h2>Global Cross-region Inference</h2>
<table><thead><tr><th>Anthropic models</th><th>Price per 1M input tokens</th><th>Price per 1M output tokens</th></tr></thead>
<tbody><tr><td>Claude Example</td><td>{priceOf!bedrockfoundationmodels/bedrockfoundationmodels!GLOBAL}</td><td>$1.00</td></tr></tbody></table>
<h2>Geo and In-region Cross-region Inference</h2>
<table><thead><tr>
<th>Anthropic models</th>
<th>Price per 1M input tokens</th>
<th>Price per 1M output tokens</th>
<th>Price per 1M input tokens (batch)</th>
<th>Price per 1M input tokens (5m cache write)</th>
<th>Price per 1M input tokens (1h cache write)</th>
<th>Price per 1M input tokens (cache read)</th>
</tr></thead>
<tbody>
<tr><td>Claude Example</td><td>{priceOf!bedrockfoundationmodels/bedrockfoundationmodels!GEOIN}</td><td>$11.00</td><td>$0.10</td><td>$2.75</td><td>$4.40</td><td>$0.22</td></tr>
<tr><td>Claude Example - Long Context</td><td>$99.00</td><td>$99.00</td><td></td><td></td><td></td><td></td></tr>
</tbody></table>
<h2>Priority tier pricing</h2>
<table><thead><tr><th>Models</th><th>Price per 1M input tokens</th><th>Price per 1M output tokens</th></tr></thead>
<tbody><tr><td>Claude Example</td><td>$0.01</td><td>$0.01</td></tr></tbody></table>
<h2>Cohere</h2>
<table><thead><tr><th>Cohere models</th><th>Price per 1M input tokens</th><th>Price per 1M output tokens</th><th>Price per image</th></tr></thead>
<tbody>
<tr><td>Command</td><td>$1.00</td><td>$2.00</td><td>$0.001</td></tr>
<tr><td>Command R+</td><td>$3.00</td><td>$15.00</td><td>N/A</td></tr>
<tr><td>Command R</td><td>$0.50</td><td>$1.50</td><td>N/A</td></tr>
<tr><td>Claude Haiku 4.5</td><td>$0.80</td><td>$4.00</td><td></td></tr>
</tbody></table>
<h2>Global example</h2>
<table><thead><tr><th>Anthropic models</th><th>Price per 1M input tokens</th><th>Price per 1M output tokens</th></tr></thead>
<tbody><tr><td>Claude 4.5 Haiku</td><td>$0.01</td><td>$0.02</td></tr></tbody></table>
`

describe('bedrock price list', () => {
  const parsed = parseBedrockOffer(OFFER)

  it('keeps standard on-demand rates and drops other tiers', () => {
    expect(parsed.byId.get('moonshotai.kimi-k3')).toEqual({
      input_tokens: 0.0033 / 1e3,
      output_tokens: 0.0165 / 1e3,
      cache_read_tokens: 0.00033 / 1e3,
    })
    expect(parsed.byName.get(bedrockNameKey('Qwen3 32B'))).toEqual({
      input_tokens: 0.15 / 1e6,
      output_tokens: 0.6 / 1e6,
    })
    expect(
      parsed.byId.get('moonshotai.kimi-k3')?.cache_write_tokens,
    ).toBeUndefined()
  })

  it('indexes an offer id by its model name when the card id differs', () => {
    expect(parsed.byName.get(bedrockNameKey('DeepSeek V3.1'))).toEqual({
      input_tokens: 0.00055 / 1e3,
      output_tokens: 0.0022 / 1e3,
    })
    expect(
      parsed.byName.get(bedrockNameKey('Qwen3 Next 80B A3B'))?.input_tokens,
    ).toBe(0.00014 / 1e3)
    expect(
      matchBedrockModelId(parsed.byId.keys(), 'qwen.qwen3-next-80b-a3b'),
    ).toBeNull()
    expect(bedrockNameKey('Command R\\+')).toBe('command r+')
    expect(bedrockNameKey('Claude Haiku 4.5')).toBe(
      bedrockNameKey('Claude 4.5 Haiku'),
    )
    expect(bedrockNameKey('Ministral 3 8B')).not.toBe(
      bedrockNameKey('Ministral 8B 3.0'),
    )
  })

  it('drops a model priced as both speech and text', () => {
    expect(parsed.byName.has(bedrockNameKey('Nova Sonic'))).toBe(false)
    expect([...parsed.byId.keys()].some((id) => /sonic/i.test(id))).toBe(false)
  })

  it('joins a versioned model id on a boundary', () => {
    expect(matchBedrockModelId(parsed.byId.keys(), 'moonshotai.kimi-k3')).toBe(
      'moonshotai.kimi-k3',
    )
    expect(
      matchBedrockModelId(
        ['qwen.qwen3-32b', 'qwen.qwen3'],
        'qwen.qwen3-32b-v1:0',
      ),
    ).toBe('qwen.qwen3-32b')
    expect(matchBedrockModelId(['deepseek.v3'], 'deepseek.v3.2')).toBeNull()
  })
})

describe('bedrock pricing page', () => {
  const page = parseBedrockPricingPage(PAGE, METER)

  it('uses the geo table, including cache columns, and ignores global, batch, priority, and long context', () => {
    expect(page.get(bedrockNameKey('Claude Example'))).toEqual({
      input_tokens: 2.2 / 1e6,
      output_tokens: 11 / 1e6,
      cache_write_tokens: 2.75 / 1e6,
      cache_write_1h_tokens: 4.4 / 1e6,
      cache_read_tokens: 0.22 / 1e6,
    })
    expect(page.has(bedrockNameKey('Claude Example - Long Context'))).toBe(
      false,
    )
  })

  it('reads a literal dollar row and skips the per-image column', () => {
    expect(page.get(bedrockNameKey('Command'))).toEqual({
      input_tokens: 1 / 1e6,
      output_tokens: 2 / 1e6,
    })
    expect(page.get('command r+')).toEqual({
      input_tokens: 3 / 1e6,
      output_tokens: 15 / 1e6,
    })
    expect(page.get('command r')).toEqual({
      input_tokens: 0.5 / 1e6,
      output_tokens: 1.5 / 1e6,
    })
  })

  it('joins both Claude name orders and ignores the global spelling', () => {
    expect(page.get(bedrockNameKey('Claude 4.5 Haiku'))).toEqual({
      input_tokens: 0.8 / 1e6,
      output_tokens: 4 / 1e6,
    })
  })

  it('prefers the offer id over the page', () => {
    const offer = parseBedrockOffer(OFFER)
    const hit = lookupBedrockPrice(
      {
        offerById: offer.byId,
        offerByName: offer.byName,
        pageByName: page,
        offerHash: 'offer',
        pageHash: 'page',
      },
      'moonshotai.kimi-k3',
      'Claude Example',
    )
    expect(hit?.url).toBe(BEDROCK_PRICE_LIST_URL)
    expect(hit?.rates.input_tokens).toBeCloseTo(3.3 / 1e6)
  })

  it('uses the page when the offer has no row', () => {
    const offer = parseBedrockOffer(OFFER)
    const book = {
      offerById: offer.byId,
      offerByName: offer.byName,
      pageByName: page,
      offerHash: 'offer',
      pageHash: 'page',
    }
    const hit = lookupBedrockPrice(
      book,
      'anthropic.claude-example',
      'Claude Example',
    )
    expect(hit?.url).toBe(BEDROCK_PRICING_PAGE_URL)
    expect(hit?.hash).toBe('page')
    const command = lookupBedrockPrice(
      book,
      'cohere.command-r-plus',
      'Command R\\+',
    )
    expect(command?.rates.input_tokens).toBeCloseTo(3 / 1e6)
    const deepseek = lookupBedrockPrice(
      book,
      'deepseek.v3-v1:0',
      'DeepSeek-V3.1',
    )
    expect(deepseek?.url).toBe(BEDROCK_PRICE_LIST_URL)
    expect(deepseek?.rates.input_tokens).toBeCloseTo(0.00055 / 1e3)
    const haiku = lookupBedrockPrice(
      book,
      'anthropic.claude-haiku-4-5',
      'Claude Haiku 4.5',
    )
    expect(haiku?.rates.input_tokens).toBeCloseTo(0.8 / 1e6)
  })
})
