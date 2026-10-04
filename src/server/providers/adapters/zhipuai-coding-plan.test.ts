import { afterEach, describe, expect, it } from 'vitest'

import {
  provider,
  ZHIPU_CODING_MODELS_URL,
  ZHIPU_CODING_OVERVIEW_URL,
} from './zhipuai-coding-plan.ts'

/** Excerpts of the Coding Plan overview and model-switch guide (2026-10-04). */
const OVERVIEW = `
* 所有套餐均支持 **GLM-5.3**、GLM-5.3-Flash。
* 调用历史模型 GLM-5.2、GLM-5.1 都将自动切换至 GLM-5.3，调用 GLM-5-Turbo、GLM-4.7 将自动切换至 GLM-5.3-Flash。
`

const LATEST = `
例如 glm-5.3 或 glm-5.3-flash。
"ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.3-flash[1m]"
注意开启 GLM 1M 上下文需要模型后缀加上 \`[1m]\` ，即 \`glm-5.3-flash[1m]\`
`

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('zhipuai-coding-plan', () => {
  it('lists the Coding Plan wire ids and leaves point prices null', async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((url: string) => {
      urls.push(String(url))
      if (String(url) === ZHIPU_CODING_OVERVIEW_URL) {
        return Promise.resolve(new Response(OVERVIEW))
      }
      if (String(url) === ZHIPU_CODING_MODELS_URL) {
        return Promise.resolve(new Response(LATEST))
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
    }) as typeof fetch

    const listed = await provider.listModels({})
    const spec = await provider.fetchSpec({})

    expect(listed.models.map((model) => model.rawId)).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.3-flash[1m]',
    ])
    expect(listed.models.every((model) => model.pricing == null)).toBe(true)
    expect(listed.models.every((model) => model.activity == null)).toBe(true)
    expect(
      listed.models.some((model) => model.rawId.startsWith('glm-5.2')),
    ).toBe(false)
    expect(spec.skipped).toContain('skipped')
    expect(urls).toEqual([ZHIPU_CODING_OVERVIEW_URL, ZHIPU_CODING_MODELS_URL])
  })
})
