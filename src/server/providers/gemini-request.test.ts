import { describe, expect, it } from 'vitest'

import type { GeminiBudgetBody } from './gemini-features.ts'
import { geminiRequestMap, parseGeminiWire } from './gemini-request.ts'

/**
 * Slice of the Generative Language discovery document (v1beta, 2026-10-08).
 * `ThinkingConfig.thinkingLevel` is the uppercase enum. `Content.role`
 * allows only user and model. Permission.role is a different field.
 */
const discovery = {
  schemas: {
    ThinkingConfig: {
      properties: {
        thinkingLevel: {
          description: 'Recommended for Gemini 3 or later models.',
          enum: [
            'THINKING_LEVEL_UNSPECIFIED',
            'MINIMAL',
            'LOW',
            'MEDIUM',
            'HIGH',
          ],
        },
        thinkingBudget: {
          description:
            'The number of thoughts tokens that the model should generate.',
        },
      },
    },
    Content: {
      properties: {
        role: {
          description:
            "Optional. The producer of the content. Must be either 'user' or 'model'. Useful to set for multi-turn conversations, otherwise can be left blank or unset.",
        },
      },
    },
    Permission: {
      properties: {
        role: { description: 'Required. The role granted by this permission.' },
      },
    },
  },
}

const budget = (off: number | null): GeminiBudgetBody => ({ on: -1, off })

describe('gemini discovery request map', () => {
  it('reads the thinking enum and the user-or-model role', () => {
    expect(parseGeminiWire(discovery)).toEqual({
      thinkingLevels: ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'],
      hasThinkingBudget: true,
      developerRole: false,
    })
  })

  it('throws when the document states none of the request-map fields', () => {
    expect(() => parseGeminiWire({ schemas: {} })).toThrow(
      'gemini discovery: no request-map fields',
    )
  })

  it('maps an effort model onto thinkingLevel HIGH and leaves max tokens unset', () => {
    const wire = parseGeminiWire(discovery)
    expect(
      geminiRequestMap(
        wire,
        { mode: 'effort', mandatory: true, efforts: ['low', 'medium', 'high'] },
        null,
      ),
    ).toEqual({
      thinking: {
        on: {
          generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } },
        },
        off: null,
        levels: {
          off: null,
          minimal: null,
          low: 'LOW',
          medium: 'MEDIUM',
          high: 'HIGH',
          xhigh: null,
          max: null,
        },
      },
      maxTokensField: null,
      developerRole: false,
      replayReasoningContent: null,
      store: null,
      strictTools: null,
      sessionAffinity: null,
      cacheControl: null,
      toolStream: null,
      reasoningEffort: null,
    })
  })

  it('maps a budget model onto the published dynamic and disable numbers', () => {
    const wire = parseGeminiWire(discovery)
    expect(
      geminiRequestMap(wire, { mode: 'budget', mandatory: false }, budget(0))
        ?.thinking,
    ).toEqual({
      on: { generationConfig: { thinkingConfig: { thinkingBudget: -1 } } },
      off: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
      levels: null,
    })
    expect(
      geminiRequestMap(wire, { mode: 'budget', mandatory: true }, budget(null))
        ?.thinking?.off,
    ).toBeNull()
  })

  it('stays a map with thinking unset when only the role is verified', () => {
    const wire = parseGeminiWire(discovery)
    const map = geminiRequestMap(wire, null, null)
    expect(map?.developerRole).toBe(false)
    expect(map?.thinking).toBeNull()
    expect(map?.maxTokensField).toBeNull()
  })

  it('returns null when neither the role nor a thinking body is verified', () => {
    const wire = parseGeminiWire({
      schemas: {
        ThinkingConfig: {
          properties: {
            thinkingLevel: { enum: ['LOW', 'HIGH'] },
          },
        },
      },
    })
    expect(wire.developerRole).toBeNull()
    expect(
      geminiRequestMap(
        wire,
        { mode: 'effort', mandatory: null, efforts: ['low'] },
        null,
      ),
    ).toBeNull()
  })
})
