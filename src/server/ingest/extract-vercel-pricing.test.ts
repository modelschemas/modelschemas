import { describe, expect, it } from 'vitest'
import { compileOpenRouterPricing } from '@modelschemas/rate-card'

import {
  compileVercelEndpointRange,
  vercelEndpointsUrl,
  vercelRangePath,
  VERCEL_PRICING_EXTRACT_CRON,
} from './extract-vercel-pricing.ts'
import { SPEC_SYNC_SHARD_CRONS } from './sync.ts'

const source = {
  url: 'https://ai-gateway.vercel.sh/v1/models/alibaba/qwen-3-235b/endpoints',
  hash: 'ab'.repeat(32),
  extractedAt: '2026-10-23T00:00:00.000Z',
}

function endpoint(
  provider: string,
  prompt: string,
  completion: string,
  status = 0,
) {
  return {
    provider_name: provider,
    status,
    pricing: {
      prompt,
      completion,
      request: '0',
      image: '0',
    },
  }
}

describe('compileVercelEndpointRange', () => {
  it('ranges status-0 routes and names the inline cards by provider', () => {
    const { range, skipped } = compileVercelEndpointRange(
      'alibaba/qwen-3-235b',
      {
        data: {
          endpoints: [
            endpoint('deepinfra', '0.00000009', '0.00000055'),
            endpoint('vertex', '0.00000022', '0.00000088'),
          ],
        },
      },
      source,
    )
    expect(skipped).toEqual([])
    expect(range?.currency).toBe('USD')
    expect(range?.inputPerMillion).toEqual({ min: 0.09, max: 0.22 })
    expect(range?.routes.map((route) => route.provider)).toEqual([
      'deepinfra',
      'vertex',
    ])
    expect(range?.routes[0]?.card).toEqual(
      compileOpenRouterPricing(
        endpoint('deepinfra', '0.00000009', '0.00000055').pricing,
        source,
      ),
    )
    expect(range?.routes[0]?.model).toBe('deepinfra')
  })

  it('omits a non-zero status and names it, and refuses when a price is missing', () => {
    const down = compileVercelEndpointRange(
      'm',
      {
        data: {
          endpoints: [
            endpoint('deepinfra', '0.00000009', '0.00000055'),
            endpoint('vertex', '0.00000022', '0.00000088', 1),
            endpoint('bedrock', '0.0000001', '0.0000002'),
          ],
        },
      },
      source,
    )
    expect(down.skipped).toEqual(['vertex'])
    expect(vercelRangePath(down.skipped)).toBe(
      'data.endpoints[status=0].pricing; skipped status!=0: vertex',
    )
    expect(down.range?.routes).toHaveLength(2)

    const gap = compileVercelEndpointRange(
      'm',
      {
        data: {
          endpoints: [
            endpoint('deepinfra', '0.00000009', '0.00000055'),
            {
              provider_name: 'vertex',
              status: 0,
              pricing: { prompt: '0', completion: '0' },
            },
          ],
        },
      },
      source,
    )
    expect(gap.range).toBeNull()
  })

  it('refuses a tiered endpoint price instead of storing part of the range', () => {
    const { range } = compileVercelEndpointRange(
      'm',
      {
        data: {
          endpoints: [
            endpoint('deepinfra', '0.00000009', '0.00000055'),
            {
              provider_name: 'vertex',
              status: 0,
              pricing: {
                prompt: '0.00000022',
                completion: '0.00000088',
                overrides: [{ min_prompt_tokens: 1000, prompt: '0.0000004' }],
              },
            },
          ],
        },
      },
      source,
    )
    expect(range).toBeNull()
  })
})

describe('VERCEL_PRICING_EXTRACT_CRON', () => {
  it('is a daily firing of its own, not the models poll', async () => {
    expect(VERCEL_PRICING_EXTRACT_CRON).toBe('0 4 * * *')
    expect(
      (SPEC_SYNC_SHARD_CRONS as ReadonlyArray<string>).includes(
        VERCEL_PRICING_EXTRACT_CRON,
      ),
    ).toBe(false)
    const fs = await import('node:fs/promises')
    const raw = await fs.readFile('wrangler.jsonc', 'utf8')
    expect(raw).toContain(`"${VERCEL_PRICING_EXTRACT_CRON}"`)
    expect(vercelEndpointsUrl('alibaba/qwen-3-235b')).toBe(
      'https://ai-gateway.vercel.sh/v1/models/alibaba/qwen-3-235b/endpoints',
    )
  })
})
