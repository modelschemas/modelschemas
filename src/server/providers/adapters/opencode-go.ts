/**
 * OpenCode Go — chat models from the public models.dev catalog (`opencode-go`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'opencode-go',
  displayName: 'OpenCode Go',
  serverUrl: 'https://opencode.ai/zen/go/v1',
  docUrl: 'https://opencode.ai/docs/go',
})
