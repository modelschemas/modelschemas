import { describe, expect, it } from 'vitest'

import { elevenlabsEnumModels } from './elevenlabs.ts'
import type { OpenApiDocument } from './types.ts'

const jsonBody = (schema: unknown) => ({
  post: { requestBody: { content: { 'application/json': { schema } } } },
})

const spec = {
  openapi: '3.1.0',
  paths: {
    '/v1/music': jsonBody({ $ref: '#/components/schemas/Music' }),
    '/v1/text-to-voice/design': jsonBody({
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          enum: ['eleven_multilingual_ttv_v2', 'eleven_ttv_v3'],
        },
      },
    }),
    '/v1/sound-generation': jsonBody({ $ref: '#/components/schemas/SFX' }),
  },
  components: {
    schemas: {
      Music: {
        properties: { model_id: { $ref: '#/components/schemas/MusicModelID' } },
      },
      MusicModelID: {
        type: 'string',
        enum: ['music_v1', 'music_v2', 'music_v2_5'],
        'x-fern-enum': { music_v1: { deprecated: true } },
      },
      SFX: {
        properties: { model_id: { $ref: '#/components/schemas/SFXModelId' } },
      },
      SFXModelId: { type: 'string', enum: ['eleven_text_to_sound_v2'] },
    },
  },
} as unknown as OpenApiDocument

describe('elevenlabsEnumModels', () => {
  it('reads model_id enums off each generation route', () => {
    expect(elevenlabsEnumModels(spec)).toEqual([
      { rawId: 'music_v1', schemaEndpointId: 'v1/music', deprecated: true },
      { rawId: 'music_v2', schemaEndpointId: 'v1/music', deprecated: false },
      { rawId: 'music_v2_5', schemaEndpointId: 'v1/music', deprecated: false },
      {
        rawId: 'eleven_multilingual_ttv_v2',
        schemaEndpointId: 'v1/text-to-voice/design',
        deprecated: false,
      },
      {
        rawId: 'eleven_ttv_v3',
        schemaEndpointId: 'v1/text-to-voice/design',
        deprecated: false,
      },
      {
        rawId: 'eleven_text_to_sound_v2',
        schemaEndpointId: 'v1/sound-generation',
        deprecated: false,
      },
    ])
  })

  it('throws when a route loses its enum', () => {
    const broken = {
      ...spec,
      paths: { ...spec.paths, '/v1/sound-generation': jsonBody({}) },
    } as OpenApiDocument
    expect(() => elevenlabsEnumModels(broken)).toThrow('v1/sound-generation')
  })
})
