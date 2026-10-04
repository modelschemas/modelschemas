/**
 * Kimi For Coding (China) — chat models from the public models.dev catalog (`kimi-code-plan-cn`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'kimi-code-plan-cn',
  displayName: 'Kimi For Coding (China)',
  serverUrl: 'https://api.kimi.com/coding/v1',
  docUrl: 'https://www.kimi.com/code/docs/en/kimi-code/models.html',
})
