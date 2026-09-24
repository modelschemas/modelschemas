import { describe, expect, it } from 'vitest'

import {
  bflGenerationEndpointId,
  bflModelActivity,
  byteplusGenerationEndpointId,
  displayNameFromRawId,
  geminiGenerationEndpointId,
  grokGenerationEndpointId,
  grokModelActivity,
  groqGenerationEndpointId,
  groqModelActivity,
  mistralGenerationEndpointId,
  mistralModelActivity,
  openaiGenerationEndpointId,
  openaiModelActivity,
  openrouterGenerationEndpointId,
  openrouterModelActivity,
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

  it('derives OpenRouter activity from output modalities', () => {
    expect(openrouterModelActivity(['video'])).toBe('video')
    expect(openrouterModelActivity(['image'])).toBe('image')
    expect(openrouterModelActivity(['text', 'image'])).toBe('chat')
    expect(openrouterModelActivity(['embeddings'])).toBe('embeddings')
    expect(openrouterModelActivity(['audio'])).toBe('audio')
    expect(openrouterModelActivity(['text'])).toBe('chat')
    expect(openrouterModelActivity(undefined)).toBe('chat')
  })

  it('binds OpenRouter video onto the per-model synthesised path', () => {
    expect(openrouterGenerationEndpointId('google/veo-3.1', 'video')).toBe(
      'videos/google/veo-3.1',
    )
    expect(openrouterGenerationEndpointId('openai/gpt-4o', 'chat')).toBe(
      'chat/completions',
    )
    expect(
      openrouterGenerationEndpointId('black-forest-labs/flux.2-pro', 'image'),
    ).toBeNull()
  })

  it('binds BFL model ids onto /v1/{rawId}', () => {
    expect(bflModelActivity('flux-2-pro')).toBe('image')
    expect(bflModelActivity('flux-3-video')).toBe('video')
    expect(bflGenerationEndpointId('flux-2-pro')).toBe('v1/flux-2-pro')
    expect(bflGenerationEndpointId('flux-3-video')).toBe('v1/flux-3-video')
  })

  it('binds BytePlus activities, splitting Seed Speech ASR vs TTS', () => {
    expect(byteplusGenerationEndpointId('seed-2-0-pro-260328', 'chat')).toBe(
      'chat/completions',
    )
    expect(byteplusGenerationEndpointId('seedream-5-0-260128', 'image')).toBe(
      'images/generations',
    )
    expect(
      byteplusGenerationEndpointId('seedance-1-0-pro-250528', 'video'),
    ).toBe('contents/generations/tasks')
    expect(byteplusGenerationEndpointId('seed-audio-1.0', 'audio')).toBe(
      'tts/create',
    )
    expect(byteplusGenerationEndpointId('seed-asr', 'audio')).toBe(
      'auc/bigmodel/recognize/flash',
    )
  })
})

describe('groq model meta', () => {
  it('reads activity from output_modalities and splits audio routes', () => {
    const tts = {
      id: 'canopylabs/orpheus-v1-english',
      output_modalities: ['speech'],
    }
    const stt = { id: 'whisper-large-v3', output_modalities: ['transcription'] }
    const chat = { id: 'allam-2-7b', output_modalities: ['text'] }
    expect(groqModelActivity(tts)).toBe('audio')
    expect(groqModelActivity(stt)).toBe('audio')
    expect(groqModelActivity(chat)).toBe('chat')
    expect(
      groqModelActivity({ id: 'meta-llama/llama-prompt-guard-2-22m' }),
    ).toBe('chat')
    expect(groqGenerationEndpointId(tts.id, 'audio')).toBe(
      'openai/v1/audio/speech',
    )
    expect(groqGenerationEndpointId(stt.id, 'audio')).toBe(
      'openai/v1/audio/transcriptions',
    )
    expect(groqGenerationEndpointId(chat.id, 'chat')).toBe(
      'openai/v1/chat/completions',
    )
  })
})

describe('mistral model meta', () => {
  it('reads activity from capability flags, falling back to the id', () => {
    const act = (id: string, flags: Record<string, boolean> = {}) =>
      mistralModelActivity({ id, capabilities: flags })
    expect(
      act('codestral-2508', { completion_chat: true, completion_fim: true }),
    ).toBe('chat')
    expect(
      act('voxtral-small-latest', { completion_chat: true, audio: true }),
    ).toBe('chat')
    expect(
      act('mistral-moderation-2603', {
        classification: true,
        moderation: true,
      }),
    ).toBe('moderation')
    expect(act('voxtral-mini-tts-latest', { audio_speech: true })).toBe('audio')
    expect(act('voxtral-mini-latest', { audio_transcription: true })).toBe(
      'audio',
    )
    expect(act('codestral-embed')).toBe('embeddings')
    expect(act('mistral-ocr-latest', { ocr: true, vision: true })).toBeNull()
  })

  it('binds each activity to its route', () => {
    expect(mistralGenerationEndpointId('mistral-large-latest', 'chat')).toBe(
      'v1/chat/completions',
    )
    expect(mistralGenerationEndpointId('mistral-embed', 'embeddings')).toBe(
      'v1/embeddings',
    )
    expect(
      mistralGenerationEndpointId('mistral-moderation-2603', 'moderation'),
    ).toBe('v1/moderations')
    expect(
      mistralGenerationEndpointId('voxtral-mini-tts-latest', 'audio'),
    ).toBe('v1/audio/speech')
    expect(mistralGenerationEndpointId('voxtral-mini-latest', 'audio')).toBe(
      'v1/audio/transcriptions',
    )
    expect(
      mistralGenerationEndpointId('voxtral-mini-realtime-latest', 'audio'),
    ).toBeNull()
  })
})
