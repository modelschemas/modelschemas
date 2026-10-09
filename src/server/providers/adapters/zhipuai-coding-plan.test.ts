import { ZHIPU_THINKING_MODE_URL } from '../provider-replay.ts'
import { GLM_REPLAY_FIXTURE } from '../fixtures/provider-replay.ts'
import { afterEach, describe, expect, it } from 'vitest'

import { chatRequestMap } from '../request-map.ts'
import { parseZaiContextWindows, zaiSpecFacts, zaiSupportedBy } from './zai.ts'
import {
  classifyZhipuCodingPath,
  parseZhipuCodingReasoning,
  provider,
  ZHIPU_CODING_MODELS_URL,
  ZHIPU_CODING_OVERVIEW_URL,
  ZHIPU_MODEL_OVERVIEW_URL,
  ZHIPU_OPENAPI_URL,
  ZHIPU_THINKING_URL,
  ZHIPU_WORDING,
} from './zhipuai-coding-plan.ts'

/** Excerpts of the Coding Plan overview and model-switch guide (2026-10-07). */
const OVERVIEW = `
* 所有套餐均支持 **GLM-5.3**、GLM-5.3-Flash。
* 调用历史模型 GLM-5.2、GLM-5.1 都将自动切换至 GLM-5.3，调用 GLM-5-Turbo、GLM-4.7 将自动切换至 GLM-5.3-Flash。
`

const LATEST = `
例如 glm-5.3 或 glm-5.3-flash。
"ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.3-flash[1m]"
注意开启 GLM 1M 上下文需要模型后缀加上 \`[1m]\` ，即 \`glm-5.3-flash[1m]\`
`

/** Excerpt of docs.bigmodel.cn/cn/guide/start/model-overview.md (2026-10-07). */
const MODELS = `
<div className="model-table">
  | 模型 | 特点 | 上下文 | 最大输出 |
  | :- | :- | :- | :- |
  | [GLM-5.3](/cn/guide/models/text/glm-5.3) | 编程与智能体能力比肩 Claude Fable 5 | 1M | 128K |
  | [GLM-5.3-Flash](/cn/guide/models/vlm/glm-5.3-flash) | 普惠的全球前沿多模态模型 | 1M | 128K |
  | [GLM-Image](/cn/guide/models/image-generation/glm-image) | 旗舰图像生成模型 | | |
  | [GLM-OCR](/cn/guide/models/vlm/glm-ocr) | 轻量图文解析模型 | 输入：单图 ≤ 10 MB，<br />PDF ≤ 50 MB | |
</div>

  | 模型 | 特点 | 多分辨率 |
  | :- | :- | :- |
  | [CogView-4](/cn/guide/models/image-generation/cogview-4) | 通用图像生成模型 | 支持 |
`

/** Excerpt of docs.bigmodel.cn/cn/guide/capabilities/thinking.md (2026-10-07). */
const THINKING = `
* **\`reasoning_effort\`**: 控制开启思维链下的推理程度，仅 \`GLM-5.2\` 及以上支持
  * 在 API 请求中
    * 针对 \`GLM-5.3\` \`GLM-5.3-FLASH\` \`GLM-5.3-FLASHX\`，仅支持 \`max\`、\`high\`、\`low\`，其余输入将报错；
  * 在 Coding Plan 请求中
    * 针对 \`GLM-5.3\` \`GLM-5.3-FLASH\` \`GLM-5.3-FLASHX\`，\`none\`、\`minimal\`、\`low\` 映射为 \`low\`；\`medium\`、\`high\` 映射为 \`high\`；\`xhigh\`、\`max\` 映射为 \`max\`
    * 针对 \`GLM-5.2\`，\`none\` 或 \`minimal\` 代表模型放弃思考；\`low\` / \`medium\` 映射为 \`high\`；\`xhigh\` 映射为 \`max\`
* **\`model\`**: 支持深度思考的模型，\`GLM-4.5\` 及其以上版本支持。
`

/** `max_tokens` and restriction prose of the China OpenAPI document (2026-10-07). */
const TEXT_MAX_TOKENS =
  '模型输出的最大令牌`token`数量限制。`GLM-5.3` `GLM-5.2` `GLM-5.1` `GLM-5` `GLM-4.7` `GLM-4.6`系列最大支持`128K`输出长度，`GLM-4.5`系列最大支持`96K`输出长度，建议设置不小于`1024`。'
const VISION_MAX_TOKENS =
  '模型输出的最大令牌`token`数量限制。`GLM-5.3-Flash`系列 `GLM-5V-Turbo`最大支持`128K`输出长度，`GLM-4.6V`最大支持`32K`输出长度，`AutoGLM-Phone`最大支持`4K`输出长度，`GLM-4.1v`系列最大支持`16K`输出长度，建议设置不小于`1024`。'
const THINKING_PARAM =
  '仅 `GLM-4.5` 及以上模型支持此参数配置. 控制大模型是否开启思维链。'
const TEXT_EFFORT =
  '控制模型的推理程度，`thinking` 开启时生效，默认 `max`，仅  `GLM-5.2` 及其以上模型支持。对于 `GLM-5.3` `GLM-5.3-FLASH` 模型，仅支持 low / high / max 档位。'
const VISION_TOOLS =
  '模型可以调用的工具列表。仅限`GLM-5.3-Flash`系列 `GLM-4.6V`和`AutoGLM-Phone`支持。最多支持 `128` 个函数。'
const RESPONSE_FORMAT =
  '指定模型的响应输出格式，默认为`text`，仅文本模型支持此字段。'

const part = (type: string) => ({
  type: 'object',
  properties: { type: { type: 'string', enum: [type] } },
})

const message = (role: string, content: unknown) => ({
  type: 'object',
  properties: { role: { type: 'string', enum: [role] }, content },
})

const chat = (variants: Array<unknown>) => ({
  post: {
    requestBody: {
      content: { 'application/json': { schema: { oneOf: variants } } },
    },
  },
})

/** Excerpt of docs.bigmodel.cn/openapi/openapi.json (2026-10-07), same nesting. */
function spec(
  overrides: {
    textMaxTokens?: string
    textMaximum?: number
    visionTools?: string
    textModels?: Array<string>
  } = {},
) {
  const shared = {
    temperature: { type: 'number' },
    thinking: { $ref: '#/components/schemas/ChatThinking' },
    tool_choice: { oneOf: [{ type: 'string', enum: ['auto'] }] },
    stop: { type: 'array' },
  }
  const text = {
    title: '文本模型',
    type: 'object',
    properties: {
      ...shared,
      model: {
        type: 'string',
        enum: overrides.textModels ?? ['glm-5.3', 'glm-5.2', 'glm-4.5-air'],
      },
      // A text-only content is a bare string schema here.
      messages: {
        type: 'array',
        items: { oneOf: [message('user', { type: 'string' })] },
      },
      reasoning_effort: {
        type: 'string',
        description: TEXT_EFFORT,
        enum: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'],
      },
      max_tokens: {
        type: 'integer',
        description: overrides.textMaxTokens ?? TEXT_MAX_TOKENS,
        maximum: overrides.textMaximum ?? 131072,
      },
      tool_stream: { type: 'boolean' },
      tools: { type: 'array', description: '模型可以调用的工具列表。' },
      response_format: { type: 'object', description: RESPONSE_FORMAT },
    },
  }
  const vision = {
    title: '视觉模型',
    type: 'object',
    properties: {
      ...shared,
      model: {
        type: 'string',
        enum: ['glm-5.3-flashx', 'glm-5.3-flash', 'glm-4.6v'],
      },
      messages: {
        type: 'array',
        items: {
          oneOf: [
            message('user', {
              oneOf: [
                {
                  type: 'array',
                  items: {
                    oneOf: ['text', 'image_url', 'video_url', 'file'].map(part),
                  },
                },
                { type: 'string' },
              ],
            }),
          ],
        },
      },
      reasoning_effort: { type: 'string', enum: ['max', 'high', 'low'] },
      max_tokens: {
        type: 'integer',
        description: VISION_MAX_TOKENS,
        maximum: 131072,
      },
      tools: {
        type: 'array',
        description: overrides.visionTools ?? VISION_TOOLS,
      },
    },
  }
  // Not a plan model: its `input_audio` part and cap wording are never read.
  const audio = {
    title: '音频模型',
    type: 'object',
    properties: {
      model: { type: 'string', enum: ['glm-4-voice', '禁用仅占位'] },
      messages: {
        type: 'array',
        items: {
          oneOf: [
            message('user', {
              oneOf: [
                {
                  type: 'array',
                  items: { oneOf: ['text', 'input_audio'].map(part) },
                },
              ],
            }),
          ],
        },
      },
      max_tokens: { type: 'integer', description: '默认`1024`。' },
    },
  }
  return {
    openapi: '3.0.1',
    info: { title: 'ZHIPU AI API', version: '1.0.0' },
    paths: {
      '/paas/v4/chat/completions': chat([text, vision, audio]),
      '/paas/v4/async/chat/completions': chat([audio]),
      '/paas/v4/images/generations': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { model: { type: 'string', enum: ['glm-5.3'] } },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        ChatThinking: {
          type: 'object',
          description: THINKING_PARAM,
          properties: {
            type: { type: 'string', enum: ['enabled', 'disabled'] },
          },
        },
      },
    },
  }
}

const DOCS: Record<string, string> = {
  [ZHIPU_THINKING_MODE_URL]: GLM_REPLAY_FIXTURE,
  [ZHIPU_CODING_OVERVIEW_URL]: OVERVIEW,
  [ZHIPU_CODING_MODELS_URL]: LATEST,
  [ZHIPU_OPENAPI_URL]: JSON.stringify(spec()),
  [ZHIPU_MODEL_OVERVIEW_URL]: MODELS,
  [ZHIPU_THINKING_URL]: THINKING,
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function serve(docs: Record<string, string>): Array<string> {
  const urls: Array<string> = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    const body = docs[String(url)]
    return body === undefined
      ? Promise.reject(new Error(`unexpected fetch: ${String(url)}`))
      : Promise.resolve(new Response(body))
  }) as typeof fetch
  return urls
}

async function listed(overrides: Record<string, string> = {}) {
  serve({ ...DOCS, ...overrides })
  const { models } = await provider.listModels({})
  return new Map(models.map((model) => [model.rawId, model]))
}

describe('zhipuai-coding-plan', () => {
  it('lists the Coding Plan ids and leaves point prices null', async () => {
    const urls = serve(DOCS)
    const { models } = await provider.listModels({})

    expect(models.map((model) => model.rawId)).toEqual([
      'glm-5.3',
      'glm-5.3-flash',
    ])
    expect(models.every((model) => model.pricing == null)).toBe(true)
    // The guide's `glm-5.3-flash[1m]` is a Claude Code name suffix, not an id.
    expect(models.map((model) => model.activity)).toEqual(['chat', 'chat'])
    expect(urls).toEqual([
      ZHIPU_CODING_OVERVIEW_URL,
      ZHIPU_CODING_MODELS_URL,
      ZHIPU_OPENAPI_URL,
      ZHIPU_MODEL_OVERVIEW_URL,
      ZHIPU_THINKING_URL,
      ZHIPU_THINKING_MODE_URL,
    ])
  })

  it('syncs the chat document and classifies only its chat route', async () => {
    serve(DOCS)
    const fetched = await provider.fetchSpec({})

    expect(fetched.sources.map((source) => source.url)).toEqual([
      ZHIPU_OPENAPI_URL,
    ])
    expect(fetched.specs).toHaveLength(1)
    expect(provider.classify('/paas/v4/chat/completions', {})).toBe('chat')
    expect(provider.classify('/paas/v4/async/chat/completions', {})).toBeNull()
    expect(provider.classify('/paas/v4/images/generations', {})).toBeNull()
  })

  it('fills each model from the request variant that lists it', async () => {
    const byId = await listed()

    expect(byId.get('glm-5.3')).toMatchObject({
      schemaEndpointId: 'paas/v4/chat/completions',
      contextWindow: 1_000_000,
      // "128K" is the label of the spec's exact `maximum`.
      maxOutput: 131_072,
      modalities: { input: ['text'], output: ['text'] },
      // A Coding Plan request runs `none` as low: thinking cannot stop.
      reasoning: {
        mode: 'effort',
        mandatory: true,
        efforts: ['low', 'high', 'max'],
      },
      exactCapabilities: true,
    })
    expect(byId.get('glm-5.3-flash')).toMatchObject({
      schemaEndpointId: 'paas/v4/chat/completions',
      contextWindow: 1_000_000,
      maxOutput: 131_072,
      modalities: { input: ['text', 'image', 'video', 'file'] },
      reasoning: { mandatory: true, efforts: ['low', 'high', 'max'] },
    })
    expect(byId.get('glm-5.3')?.capabilities).toEqual(
      expect.arrayContaining([
        'tools',
        'tool_choice',
        'response_format',
        'reasoning',
        'reasoning_effort',
        'max_tokens',
      ]),
    )
    // The vision request has no `response_format`.
    expect(byId.get('glm-5.3-flash')?.capabilities).toEqual(
      expect.arrayContaining(['tools', 'tool_choice', 'reasoning_effort']),
    )
    expect(byId.get('glm-5.3-flash')?.capabilities).not.toContain(
      'response_format',
    )
  })

  it('sends only effort levels the bound request variant lists', () => {
    const facts = zaiSpecFacts(spec(), undefined, {
      wording: ZHIPU_WORDING,
      classify: classifyZhipuCodingPath,
      only: (id) => id.startsWith('glm-5.3'),
    })
    for (const id of ['glm-5.3', 'glm-5.3-flash']) {
      const levels = chatRequestMap('zhipuai-coding-plan', id, 'chat')?.thinking
        ?.levels
      const sent = Object.values(levels ?? {}).filter((level) => level !== null)
      expect(sent.length).toBeGreaterThan(0)
      for (const level of sent) {
        expect(facts.get(id)?.efforts).toContain(level)
      }
    }
  })

  it('names the document each fact came from', async () => {
    const sources = (await listed()).get('glm-5.3')?.factSources

    expect(sources?.contextWindow).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: ZHIPU_MODEL_OVERVIEW_URL,
    })
    expect(sources?.reasoning).toMatchObject({
      derivation: 'docs-derived',
      sourceUrl: ZHIPU_THINKING_URL,
    })
    expect(sources?.maxOutput).toMatchObject({
      derivation: 'upstream-spec',
      sourceUrl: ZHIPU_OPENAPI_URL,
    })
    expect(sources?.modalities?.sourceUrl).toBe(ZHIPU_OPENAPI_URL)
    expect(sources?.capabilities?.tools).toMatchObject({
      sourceUrl: ZHIPU_OPENAPI_URL,
      path: '/properties/tools',
    })
    expect(sources?.pricing).toBeUndefined()
  })
})

describe('zhipuai-coding-plan parsers fail closed', () => {
  it('throws on a 200 that is a web page', async () => {
    serve({ ...DOCS, [ZHIPU_THINKING_URL]: '<!DOCTYPE html><html></html>' })
    await expect(provider.listModels({})).rejects.toThrow(
      /^zhipuai-coding-plan: .* returned HTML/,
    )
  })

  it('throws on a reworded output cap', async () => {
    for (const textMaxTokens of [
      TEXT_MAX_TOKENS.replace('系列最大支持`128K`输出长度', '系列最多`128K`'),
      TEXT_MAX_TOKENS.replace('`128K`输出长度', '`128K`上下文'),
      TEXT_MAX_TOKENS.replace('`128K`', '128K'),
      // A model with another verb must not take the next clause's cap.
      TEXT_MAX_TOKENS.replace(
        '`GLM-4.5`系列',
        '`GLM-4.6V`为视觉模型，`GLM-4.5`系列',
      ),
      '模型输出的最大令牌数量限制。',
    ]) {
      await expect(
        listed({
          [ZHIPU_OPENAPI_URL]: JSON.stringify(spec({ textMaxTokens })),
        }),
      ).rejects.toThrow(/^zhipuai-coding-plan: .*output cap/)
    }
  })

  it('stores no output cap when the label exceeds the spec maximum', async () => {
    for (const override of [
      { textMaximum: 65536 },
      { textMaxTokens: TEXT_MAX_TOKENS.replace('`128K`', '`128M`') },
    ]) {
      const byId = await listed({
        [ZHIPU_OPENAPI_URL]: JSON.stringify(spec(override)),
      })
      expect(byId.get('glm-5.3')?.maxOutput).toBeNull()
      expect(byId.get('glm-5.3')?.factSources?.maxOutput).toBeUndefined()
      // The vision variant's own cap and maximum still agree.
      expect(byId.get('glm-5.3-flash')?.maxOutput).toBe(131_072)
    }
  })

  it('throws when the chat request lists none of the plan ids', async () => {
    await expect(
      listed({
        [ZHIPU_OPENAPI_URL]: JSON.stringify(spec({ textModels: ['glm-4.7'] })),
        [ZHIPU_CODING_OVERVIEW_URL]: '* 所有套餐均支持 **GLM-5.3**。',
        [ZHIPU_CODING_MODELS_URL]: '',
      }),
    ).rejects.toThrow(/lists no model ids/)
  })

  it('leaves an id the chat request does not list unclassified', async () => {
    const byId = await listed({
      [ZHIPU_CODING_OVERVIEW_URL]: '* 所有套餐均支持 **GLM-5.3**、GLM-6。',
    })
    expect(byId.get('glm-6')).toEqual({ rawId: 'glm-6', pricing: null })
    expect(byId.get('glm-5.3')?.activity).toBe('chat')
  })

  it('drops a flag another model list claims, or one it cannot read', async () => {
    for (const visionTools of [
      '仅限`GLM-4.6V`和`AutoGLM-Phone`支持。',
      '仅限`GLM-5.3-Flash`系列（需开通权限）支持。',
      '仅 `GLM-6` 及以上模型支持。',
    ]) {
      const flash = (
        await listed({
          [ZHIPU_OPENAPI_URL]: JSON.stringify(spec({ visionTools })),
        })
      ).get('glm-5.3-flash')
      expect(flash?.capabilities).not.toContain('tools')
      expect(flash?.capabilities).not.toContain('tool_choice')
      expect(flash?.capabilities).toContain('reasoning_effort')
    }
  })

  it('reads the "only these models" clauses of the China document', () => {
    const by = (description: string, id: string) =>
      zaiSupportedBy(description, id, ZHIPU_WORDING)
    expect(by(VISION_TOOLS, 'glm-5.3-flash')).toBe(true)
    expect(by(VISION_TOOLS, 'glm-5v-turbo')).toBe(false)
    expect(by(THINKING_PARAM, 'glm-5.3')).toBe(true)
    expect(by(THINKING_PARAM, 'glm-4-flash-250414')).toBe(false)
    expect(by(TEXT_EFFORT, 'glm-5.3')).toBe(true)
    expect(by(TEXT_EFFORT, 'glm-5.1')).toBe(false)
    // "Only text models" names the variant, not a model list.
    expect(by(RESPONSE_FORMAT, 'glm-5.3')).toBeNull()
  })

  it('reads only the plan models from the context table', () => {
    const only = (name: string) => name === 'glm-5.3'
    expect(parseZaiContextWindows(MODELS, ZHIPU_WORDING, only)).toEqual(
      new Map([['glm-5.3', 1_000_000]]),
    )
    // A plan model's own cell must be a token count.
    expect(() =>
      parseZaiContextWindows(
        MODELS.replace('| 1M | 128K |', '| 约 1M | 128K |'),
        ZHIPU_WORDING,
        only,
      ),
    ).toThrow(/unreadable context window/)
    // A renamed column is not guessed at.
    expect(() =>
      parseZaiContextWindows(
        MODELS.replace('上下文', '上下文长度'),
        ZHIPU_WORDING,
        only,
      ),
    ).toThrow(/no context windows/)
  })

  it('reads the Coding Plan effort list and throws when it is reworded', () => {
    expect(parseZhipuCodingReasoning(THINKING)).toEqual([
      {
        names: ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'],
        series: false,
        reasoning: {
          mode: 'effort',
          mandatory: true,
          efforts: ['low', 'high', 'max'],
        },
      },
      {
        names: ['glm-5.2'],
        series: false,
        // `none` stops thinking here, so it is an effort and not mandatory.
        reasoning: {
          mode: 'effort',
          mandatory: false,
          efforts: ['none', 'minimal', 'high', 'max'],
        },
      },
    ])
    for (const reworded of [
      THINKING.replace('在 Coding Plan 请求中', '在编程套餐请求中'),
      THINKING.replace(
        '`medium`、`high` 映射为 `high`',
        '`medium`、`high` 均可',
      ),
      THINKING.replace('针对 `GLM-5.2`，', '针对 `GLM-5.2` 等模型，'),
      THINKING.replace('代表模型放弃思考', '将报错'),
    ]) {
      expect(() => parseZhipuCodingReasoning(reworded)).toThrow(
        /reasoning_effort/,
      )
    }
  })

  it('stores no reasoning when the list does not place `none`', async () => {
    const silent = THINKING.replace(
      '`none`、`minimal`、`low` 映射',
      '`low` 映射',
    )
    expect(parseZhipuCodingReasoning(silent).map((row) => row.names)).toEqual([
      ['glm-5.2'],
    ])
    const flash = (await listed({ [ZHIPU_THINKING_URL]: silent })).get(
      'glm-5.3-flash',
    )
    expect(flash?.reasoning).toBeUndefined()
    // No effort list for the model means no `reasoning_effort` flag either.
    expect(flash?.capabilities).not.toContain('reasoning_effort')
    expect(flash?.capabilities).toContain('tools')
  })
})
