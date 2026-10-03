/**
 * Vercel AI Gateway — chat models from the public models.dev catalog (`vercel`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'vercel',
  displayName: 'Vercel AI Gateway',
  serverUrl: 'https://ai-gateway.vercel.sh/v1',
  docUrl: 'https://vercel.com/docs/ai-gateway',
})
