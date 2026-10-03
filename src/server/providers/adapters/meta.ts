/**
 * Meta — chat models from the public models.dev catalog (`meta`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'meta',
  displayName: 'Meta',
  serverUrl: 'https://api.meta.ai/v1',
  docUrl: 'https://dev.meta.ai/docs',
})
