/**
 * NVIDIA NIM — chat models from the public models.dev catalog (`nvidia`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'nvidia',
  displayName: 'NVIDIA NIM',
  serverUrl: 'https://integrate.api.nvidia.com/v1',
  docUrl: 'https://docs.api.nvidia.com/nim/',
})
