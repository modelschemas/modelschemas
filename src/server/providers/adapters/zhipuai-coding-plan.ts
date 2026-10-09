import { glmCodingProvider, ZHIPU_CODING_SOURCES } from '../glm-coding.ts'

export const provider = glmCodingProvider(
  'zhipuai-coding-plan',
  'Zhipu AI Coding Plan',
  'zh',
  ZHIPU_CODING_SOURCES,
)
