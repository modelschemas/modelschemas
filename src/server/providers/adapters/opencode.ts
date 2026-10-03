/**
 * OpenCode Zen — chat models from the public models.dev catalog (`opencode`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'opencode',
  displayName: 'OpenCode Zen',
  serverUrl: 'https://opencode.ai/zen/v1',
  docUrl: 'https://opencode.ai/docs/zen',
})
