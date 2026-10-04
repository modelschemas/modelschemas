/**
 * Cloudflare AI Gateway — chat models from the public models.dev catalog (`cloudflare-ai-gateway`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'cloudflare-ai-gateway',
  displayName: 'Cloudflare AI Gateway',
  serverUrl: 'https://gateway.ai.cloudflare.com/v1',
  docUrl: 'https://developers.cloudflare.com/ai-gateway/',
})
