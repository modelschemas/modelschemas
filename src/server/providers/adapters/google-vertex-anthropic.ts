/**
 * Vertex (Anthropic) — chat models from the public models.dev catalog (`google-vertex-anthropic`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'google-vertex-anthropic',
  displayName: 'Vertex (Anthropic)',
  serverUrl: 'https://aiplatform.googleapis.com/v1',
  docUrl:
    'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude',
})
