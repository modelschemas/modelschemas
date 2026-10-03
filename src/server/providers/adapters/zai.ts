/**
 * Z.AI — chat models from the public models.dev catalog (`zai`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'zai',
  displayName: 'Z.AI',
  serverUrl: 'https://api.z.ai/api/paas/v4',
  docUrl: 'https://docs.z.ai/guides/overview/pricing',
})
