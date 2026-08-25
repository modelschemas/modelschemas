import { describe, expect, it } from 'vitest'

import { pinModelField, resolveSchemaEndpointId } from './schema-binding.ts'

describe('resolveSchemaEndpointId', () => {
  it('binds grok / openai / anthropic catalog rows onto generation routes', () => {
    expect(
      resolveSchemaEndpointId({
        providerId: 'grok',
        rawId: 'grok-imagine-image-2.0',
        activity: 'image',
      }),
    ).toBe('v1/images/generations')
    expect(
      resolveSchemaEndpointId({
        providerId: 'openai',
        rawId: 'gpt-image-2',
        activity: 'image',
      }),
    ).toBe('images/generations')
    expect(
      resolveSchemaEndpointId({
        providerId: 'openai',
        rawId: 'whisper-1',
        activity: 'audio',
      }),
    ).toBe('audio/transcriptions')
    expect(
      resolveSchemaEndpointId({
        providerId: 'anthropic',
        rawId: 'claude-sonnet-4-5',
        activity: 'chat',
      }),
    ).toBe('v1/messages')
    expect(
      resolveSchemaEndpointId({
        providerId: 'openrouter',
        rawId: 'google/veo-3.1',
        activity: 'video',
      }),
    ).toBe('videos/google/veo-3.1')
    expect(
      resolveSchemaEndpointId({
        providerId: 'bfl',
        rawId: 'flux-2-pro',
        activity: 'image',
      }),
    ).toBe('v1/flux-2-pro')
    expect(
      resolveSchemaEndpointId({
        providerId: 'byteplus',
        rawId: 'seedream-5-0-260128',
        activity: 'image',
      }),
    ).toBe('images/generations')
  })

  it('uses the raw id for model-grained providers and null when unbound', () => {
    expect(
      resolveSchemaEndpointId({
        providerId: 'fal',
        rawId: 'xai/grok-imagine-image/v2.0/text-to-image',
        activity: 'image',
      }),
    ).toBe('xai/grok-imagine-image/v2.0/text-to-image')
    expect(
      resolveSchemaEndpointId({
        providerId: 'grok',
        rawId: 'grok-voice-think-fast-2.0',
        activity: 'audio',
      }),
    ).toBeNull()
    expect(
      resolveSchemaEndpointId({
        providerId: 'openrouter',
        rawId: 'openai/gpt-4o',
        activity: null,
      }),
    ).toBeNull()
  })
})

describe('pinModelField', () => {
  it('narrows a string model property to a one-id enum and keeps other fields', () => {
    const schema = {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Which model to run',
          example: 'grok-imagine-image',
        },
        prompt: { type: 'string' },
      },
    }
    expect(pinModelField(schema, 'grok-imagine-image-2.0')).toEqual({
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Which model to run',
          example: 'grok-imagine-image-2.0',
          enum: ['grok-imagine-image-2.0'],
        },
        prompt: { type: 'string' },
      },
    })
  })

  it('leaves schemas without a model property unchanged', () => {
    const schema = {
      type: 'object',
      properties: { prompt: { type: 'string' } },
    }
    expect(pinModelField(schema, 'grok-4')).toBe(schema)
  })
})
