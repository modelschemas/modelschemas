import { describe, expect, it } from 'vitest'

import {
  displayNameFromRawId,
  geminiGenerationEndpointId,
  grokGenerationEndpointId,
  grokModelActivity,
  openaiGenerationEndpointId,
  openaiModelActivity,
} from './model-meta.ts'

describe('displayNameFromRawId', () => {
  it('title-cases hyphenated ids and keeps version numbers', () => {
    expect(displayNameFromRawId('grok-imagine-image-2.0')).toBe(
      'Grok Imagine Image 2.0',
    )
    expect(displayNameFromRawId('sora-2')).toBe('Sora 2')
    expect(displayNameFromRawId('text-embedding-3-small')).toBe(
      'Text Embedding 3 Small',
    )
  })

  it('uppercases GPT/TTS and special-cases DALL-E', () => {
    expect(displayNameFromRawId('gpt-image-2')).toBe('GPT Image 2')
    expect(displayNameFromRawId('gpt-4o-mini-tts')).toBe('GPT 4o Mini TTS')
    expect(displayNameFromRawId('dall-e-3')).toBe('DALL-E 3')
    expect(displayNameFromRawId('dall-e')).toBe('DALL-E')
  })
})

describe('grokModelActivity', () => {
  it('splits Imagine image / video and voice from chat', () => {
    expect(grokModelActivity('grok-imagine-image-2.0')).toBe('image')
    expect(grokModelActivity('grok-imagine-image')).toBe('image')
    expect(grokModelActivity('grok-imagine-image-quality')).toBe('image')
    expect(grokModelActivity('grok-2-image-1212')).toBe('image')
    expect(grokModelActivity('grok-imagine-video-1.5')).toBe('video')
    expect(grokModelActivity('grok-imagine-video')).toBe('video')
    expect(grokModelActivity('grok-imagine-video-1.5-preview')).toBe('video')
    expect(grokModelActivity('grok-voice-think-fast-2.0')).toBe('audio')
    expect(grokModelActivity('grok-4.6')).toBe('chat')
    expect(grokModelActivity('grok-4.20-0309-reasoning')).toBe('chat')
    expect(grokModelActivity('grok-2-vision-1212')).toBe('chat')
    expect(grokModelActivity('grok-build-0.1')).toBe('chat')
  })

  it('does not treat image as a substring of unrelated ids', () => {
    expect(grokModelActivity('grok-imagey')).toBe('chat')
  })
})

describe('openaiModelActivity', () => {
  it('classifies media / embeddings / moderation before the gpt- chat default', () => {
    expect(openaiModelActivity('gpt-image-2')).toBe('image')
    expect(openaiModelActivity('gpt-image-1.5')).toBe('image')
    expect(openaiModelActivity('dall-e-3')).toBe('image')
    expect(openaiModelActivity('chatgpt-image-latest')).toBe('image')
    expect(openaiModelActivity('sora-2')).toBe('video')
    expect(openaiModelActivity('sora-2-pro')).toBe('video')
    expect(openaiModelActivity('whisper-1')).toBe('audio')
    expect(openaiModelActivity('tts-1-hd')).toBe('audio')
    expect(openaiModelActivity('gpt-4o-mini-tts')).toBe('audio')
    expect(openaiModelActivity('gpt-4o-transcribe')).toBe('audio')
    expect(openaiModelActivity('text-embedding-3-small')).toBe('embeddings')
    expect(openaiModelActivity('omni-moderation-latest')).toBe('moderation')
    expect(openaiModelActivity('gpt-4o')).toBe('chat')
    expect(openaiModelActivity('o3-mini')).toBe('chat')
    expect(openaiModelActivity('chatgpt-4o-latest')).toBe('chat')
    expect(openaiModelActivity('gpt-4o-audio-preview')).toBe('chat')
    expect(openaiModelActivity('gpt-realtime')).toBe('chat')
  })
})

describe('generation endpoint ids', () => {
  it('binds grok activities onto the shared v1 routes', () => {
    expect(grokGenerationEndpointId('image')).toBe('v1/images/generations')
    expect(grokGenerationEndpointId('video')).toBe('v1/videos/generations')
    expect(grokGenerationEndpointId('chat')).toBe('v1/chat/completions')
    expect(grokGenerationEndpointId('audio')).toBeNull()
  })

  it('binds openai activities, splitting audio speech vs transcription', () => {
    expect(openaiGenerationEndpointId('gpt-image-2', 'image')).toBe(
      'images/generations',
    )
    expect(openaiGenerationEndpointId('sora-2', 'video')).toBe('videos')
    expect(openaiGenerationEndpointId('gpt-4o', 'chat')).toBe(
      'chat/completions',
    )
    expect(openaiGenerationEndpointId('tts-1', 'audio')).toBe('audio/speech')
    expect(openaiGenerationEndpointId('gpt-4o-mini-tts', 'audio')).toBe(
      'audio/speech',
    )
    expect(openaiGenerationEndpointId('whisper-1', 'audio')).toBe(
      'audio/transcriptions',
    )
    expect(openaiGenerationEndpointId('gpt-4o-transcribe', 'audio')).toBe(
      'audio/transcriptions',
    )
  })

  it('binds gemini by activity, using predict for Imagen', () => {
    expect(geminiGenerationEndpointId('image', ['predict'])).toBe(
      'v1beta/models/{modelsId}:predict',
    )
    expect(geminiGenerationEndpointId('image', ['generateContent'])).toBe(
      'v1beta/models/{modelsId}:generateContent',
    )
    expect(geminiGenerationEndpointId('video', ['predictLongRunning'])).toBe(
      'v1beta/models/{modelsId}:predictLongRunning',
    )
    expect(geminiGenerationEndpointId('embeddings', ['embedContent'])).toBe(
      'v1beta/models/{modelsId}:embedContent',
    )
  })
})
