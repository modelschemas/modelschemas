import { describe, expect, it } from 'vitest'

import { walkRequestSchema } from './fact-sources.ts'
import { normalizeMediaModalities } from './media-modalities.ts'

const walkMeta = {
  derivation: 'upstream-spec' as const,
  endpointId: 'bound',
}

describe('normalizeMediaModalities', () => {
  it('fills one model of each provider from the listing or request schema', () => {
    const cartesiaVoice = normalizeMediaModalities({
      activity: 'audio',
      listingInput: ['text'],
      listingOutput: ['audio'],
    })
    const deepgramNova = normalizeMediaModalities({
      activity: 'audio',
      listingInput: ['audio'],
      listingOutput: ['text'],
    })
    const assemblyUniversal = normalizeMediaModalities({
      activity: 'audio',
      listingInput: ['audio'],
      listingOutput: ['text'],
    })
    expect(cartesiaVoice).toEqual({ input: ['text'], output: ['audio'] })
    expect(deepgramNova).toEqual({ input: ['audio'], output: ['text'] })
    expect(assemblyUniversal).toEqual({ input: ['audio'], output: ['text'] })

    const klingImage = {
      type: 'object',
      properties: {
        model_name: { type: 'string' },
        prompt: { type: 'string' },
        image: { type: 'string' },
        callback_url: { type: 'string' },
      },
    }
    expect(
      normalizeMediaModalities({
        activity: 'image',
        requestSchema: klingImage,
      }),
    ).toEqual({ input: ['text', 'image'], output: ['image'] })
    expect(walkRequestSchema(klingImage, walkMeta)?.flags ?? []).toEqual([])

    expect(
      normalizeMediaModalities({
        activity: 'video',
        requestSchemas: [
          { type: 'object', properties: { prompt: { type: 'string' } } },
          {
            type: 'object',
            properties: {
              prompt: { type: 'string' },
              image: { type: 'string' },
            },
          },
        ],
      }),
    ).toEqual({ input: ['text', 'image'], output: ['video'] })

    expect(
      normalizeMediaModalities({
        activity: 'image',
        listingInput: ['text', 'image'],
        listingOutput: ['image'],
      }),
    ).toEqual({ input: ['text', 'image'], output: ['image'] })

    expect(
      normalizeMediaModalities({
        activity: 'embeddings',
        listingInput: ['text'],
        listingOutput: [],
      }),
    ).toEqual({ input: ['text'], output: [] })
  })

  it('stays empty when the row and schema name no medium', () => {
    expect(
      normalizeMediaModalities({
        activity: null,
        requestSchema: {
          type: 'object',
          properties: {
            model_name: { type: 'string' },
            callback_url: { type: 'string' },
          },
        },
      }),
    ).toBeNull()
    expect(normalizeMediaModalities({ activity: 'audio' })).toBeNull()
  })
})
