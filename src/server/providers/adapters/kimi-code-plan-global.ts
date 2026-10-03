/**
 * Kimi For Coding — chat models from the public models.dev catalog (`kimi-code-plan-global`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'kimi-code-plan-global',
  displayName: 'Kimi For Coding',
  serverUrl: 'https://api.kimi.ai/coding/v1',
  docUrl: 'https://www.kimi.ai/code/docs/en/kimi-code/models.html',
})
