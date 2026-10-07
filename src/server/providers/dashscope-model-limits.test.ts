import { describe, expect, it } from 'vitest'

import {
  dashscopeModelPageUrl,
  loadDashscopeModelLimits,
  parseDashscopeModelLimits,
} from './dashscope-model-limits.ts'

/** Context limits from qwen3-omni-flash.md, checked 2026-10-08. */
const OMNI_FIXTURE = `# qwen3-omni-flash

## Context Limits <span id="h-4b8ebeae72" />

<table><thead><tr><th>Parameter</th><th>Value</th><th>Parameter</th><th>Value</th></tr></thead><tbody><tr><td><p>Max Input Length</p></td><td><p>49152</p></td><td><p>Max Output Length</p></td><td><p>16384</p></td></tr><tr><td><p>Context Window</p></td><td><p>65536</p></td><td><p>Max Input Length (Thinking Mode)</p></td><td><p>16384</p></td></tr><tr><td><p>Max Output Length (Thinking Mode)</p></td><td><p>16384</p></td><td><p>Max Chain-of-Thought Length</p></td><td><p>32768</p></td></tr></tbody></table>

## Pricing <span id="h-d72e94e06d" />

### qwen3-omni-flash-2025-09-15 <span id="h-0c5c74dc20" />

#### Model Capabilities <span id="h-eca28b5fa5" />

<table><thead><tr><th>Capability</th><th>Support</th></tr></thead><tbody><tr><td><p>Function Calling</p></td><td><p>Supported</p></td></tr></tbody></table>

#### Context Limits <span id="h-8a43bf5ab2" />

<table><thead><tr><th>Parameter</th><th>Value</th><th>Parameter</th><th>Value</th></tr></thead><tbody><tr><td><p>Max Input Length</p></td><td><p>49152</p></td><td><p>Max Output Length</p></td><td><p>16384</p></td></tr><tr><td><p>Context Window</p></td><td><p>65536</p></td><td><p>Max Input Length (Thinking Mode)</p></td><td><p>16384</p></td></tr></tbody></table>
`

/** Context limits from qwen3-8-omni-flash-realtime.md, checked 2026-10-08. */
const REALTIME_FIXTURE = `# qwen3.8-omni-flash-realtime

## Model capabilities

| Capability | Support | Capability | Support |
| --- | --- | --- | --- |
| Input modalities | Text, streaming audio, and video | Output modalities | Text and audio |

## Context limits

| Parameter                  | Value                                   | Parameter             | Value                                    |
| -------------------------- | --------------------------------------- | --------------------- | ---------------------------------------- |
| Maximum total input tokens | 196608                                  | Audio history         | Up to 100 turns and 600 seconds in total |
| Video history              | Up to 50 turns and 240 seconds in total | Maximum output tokens | 65536                                    |

## Model pricing
`

/** Context limits from decision-model-preview.md, checked 2026-10-08. */
const DECISION_FIXTURE = `# decision-model-preview

## Context Limits <span id="h-dm-ctx" />

<table><thead><tr><th>Parameter</th><th>Value</th><th>Parameter</th><th>Value</th></tr></thead><tbody><tr><td><p>Max Input Length</p></td><td><p>65,536</p></td><td><p>Max Output Length</p></td><td><p>0</p></td></tr><tr><td><p>Context Window</p></td><td><p>65,536</p></td><td /><td /></tr></tbody></table>
`

describe('dashscope model limits', () => {
  it('reads context and non-thinking max output, including snapshot sections', () => {
    const models = parseDashscopeModelLimits(OMNI_FIXTURE)
    expect(models['qwen3-omni-flash']).toEqual({
      contextWindow: 65536,
      maxOutput: 16384,
    })
    expect(models['qwen3-omni-flash-2025-09-15']).toEqual({
      contextWindow: 65536,
      maxOutput: 16384,
    })
  })

  it('does not treat maximum input as the context window', () => {
    expect(parseDashscopeModelLimits(REALTIME_FIXTURE)).toEqual({
      'qwen3.8-omni-flash-realtime': {
        contextWindow: null,
        maxOutput: 65536,
      },
    })
  })

  it('keeps a published max output of zero', () => {
    expect(parseDashscopeModelLimits(DECISION_FIXTURE)).toEqual({
      'decision-model-preview': { contextWindow: 65536, maxOutput: 0 },
    })
  })

  it('throws when the page has no context-limit row', () => {
    expect(() => parseDashscopeModelLimits('# qwen-plus\n\nno table')).toThrow(
      /parsed 0 context-limit rows/,
    )
  })

  it('rejects an HTML shell', async () => {
    await expect(
      loadDashscopeModelLimits('<!DOCTYPE html><html></html>'),
    ).rejects.toThrow(/not markdown/)
  })

  it('points a dated snapshot at the stable model page', () => {
    expect(dashscopeModelPageUrl('qwen3-omni-flash-2025-09-15')).toBe(
      'https://www.alibabacloud.com/help/en/model-studio/qwen3-omni-flash.md',
    )
    expect(dashscopeModelPageUrl('qwen3.8-omni-flash-realtime')).toBe(
      'https://www.alibabacloud.com/help/en/model-studio/qwen3-8-omni-flash-realtime.md',
    )
  })
})
