/**
 * Zhipu AI Coding Plan — chat models from the public models.dev catalog (`zhipuai-coding-plan`).
 * listModels does not call the provider.
 */
import { modelsDevChatProvider } from '../models-dev.ts'

export const provider = modelsDevChatProvider({
  id: 'zhipuai-coding-plan',
  displayName: 'Zhipu AI Coding Plan',
  serverUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  docUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
})
