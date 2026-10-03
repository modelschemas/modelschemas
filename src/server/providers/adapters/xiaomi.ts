/**
 * Xiaomi — chat models from the public models.dev catalog (`xiaomi`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'xiaomi',
  displayName: 'Xiaomi',
  serverUrl: 'https://api.xiaomimimo.com/v1',
  docUrl: 'https://platform.xiaomimimo.com/#/docs',
})
