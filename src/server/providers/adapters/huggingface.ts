/**
 * Hugging Face — chat models from the public models.dev catalog (`huggingface`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'huggingface',
  displayName: 'Hugging Face',
  serverUrl: 'https://router.huggingface.co/v1',
  docUrl: 'https://huggingface.co/docs/inference-providers',
})
