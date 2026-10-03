/**
 * MiniMax — chat models from the public models.dev catalog (`minimax`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'minimax',
  displayName: 'MiniMax',
  serverUrl: 'https://api.minimax.io/anthropic/v1',
  docUrl: 'https://platform.minimax.io/docs/guides/quickstart',
})
