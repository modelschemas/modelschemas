/**
 * Moonshot AI (China) — chat models from the public models.dev catalog (`moonshotai-cn`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'moonshotai-cn',
  displayName: 'Moonshot AI (China)',
  serverUrl: 'https://api.moonshot.cn/v1',
  docUrl: 'https://platform.moonshot.cn/docs/api/chat',
})
