/**
 * MiniMax (China) — chat models from the public models.dev catalog (`minimax-cn`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'minimax-cn',
  displayName: 'MiniMax (China)',
  serverUrl: 'https://api.minimax.cn/anthropic/v1',
  docUrl: 'https://platform.minimaxi.com/docs/guides/quickstart',
})
