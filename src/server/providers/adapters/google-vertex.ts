/**
 * Google Vertex AI — chat models from the public models.dev catalog (`google-vertex`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'google-vertex',
  displayName: 'Google Vertex AI',
  serverUrl: 'https://aiplatform.googleapis.com/v1',
  docUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/models',
})
