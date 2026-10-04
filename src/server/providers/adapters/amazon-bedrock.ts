/**
 * Amazon Bedrock — chat models from the public models.dev catalog (`amazon-bedrock`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'amazon-bedrock',
  displayName: 'Amazon Bedrock',
  serverUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  docUrl:
    'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
})
