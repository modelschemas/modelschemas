/**
 * Cloudflare Workers AI — chat models from the public models.dev catalog (`cloudflare-workers-ai`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'cloudflare-workers-ai',
  displayName: 'Cloudflare Workers AI',
  serverUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
  docUrl: 'https://developers.cloudflare.com/workers-ai/models/',
})
