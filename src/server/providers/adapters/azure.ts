/**
 * Azure OpenAI — chat models from the public models.dev catalog (`azure`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'azure',
  displayName: 'Azure OpenAI',
  serverUrl: 'https://azure.openai.azure.com/openai',
  docUrl:
    'https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models',
})
