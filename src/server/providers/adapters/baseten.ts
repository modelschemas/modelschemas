/**
 * Baseten — chat models from the public models.dev catalog (`baseten`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'baseten',
  displayName: 'Baseten',
  serverUrl: 'https://inference.baseten.co/v1',
  docUrl: 'https://docs.baseten.co/inference/model-apis/overview',
})
