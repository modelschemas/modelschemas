/**
 * GPT-5 family facts that the per-model pages omit. The gpt-5-mini and
 * gpt-5-nano pages carry no effort sentence, and no model page states the
 * sampling parameters. Three "Using GPT-5.x" guides state them:
 * - GPT-5: the family's ids and its `reasoning.effort` levels.
 * - GPT-5.1: `none` is new, and GPT-5's `minimal` still spends reasoning
 *   tokens. `mandatory` becomes true only when that level is first in the
 *   family list, the list has no `none`, and it matches the row's efforts.
 * - GPT-5.2: `temperature` and `top_p` raise an error on the named GPT-5 ids.
 * Each parser throws when its sentence is not there; the caller loads them
 * through `tryDocs`.
 */
import type { cachedDocs } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'

export const OPENAI_GPT5_GUIDE_URL =
  'https://developers.openai.com/api/docs/guides/latest-model/gpt-5.md'
export const OPENAI_GPT51_GUIDE_URL =
  'https://developers.openai.com/api/docs/guides/latest-model/gpt-5.1.md'
export const OPENAI_GPT52_GUIDE_URL =
  'https://developers.openai.com/api/docs/guides/latest-model/gpt-5.2.md'

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Sampling parameters the guide names → capability flags. */
const SAMPLING_FLAGS: Record<string, string> = {
  temperature: 'temperature',
  top_p: 'top_p',
}

/** "`a`, `b`, and `c`" → ['a', 'b', 'c']; null when the run has other text. */
function codeList(run: string): Array<string> | null {
  const items = [...run.matchAll(/`([a-z0-9._-]+)`/g)].map((m) => m[1] ?? '')
  const rest = run
    .replace(/`[a-z0-9._-]+`/g, '')
    .replace(/,|\band\b|\bor\b/g, '')
    .trim()
  return items.length > 0 && rest === '' ? items : null
}

function prose(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '')
}

export interface Gpt5Family {
  rawIds: Array<string>
  efforts: Array<string>
}

export function parseGpt5FamilyGuide(markdown: string): Gpt5Family {
  const text = prose(markdown)
  const rawIds = codeList(
    text.match(/^- The GPT-5 family includes (.+)\.$/m)?.[1] ?? '',
  )
  const efforts = codeList(
    text.match(/^- `reasoning\.effort` supports (.+)\.$/m)?.[1] ?? '',
  )
  if (!rawIds || !efforts || efforts.some((e) => !EFFORTS.includes(e))) {
    throw new Error('openai gpt-5 guide: family or effort list unreadable')
  }
  return { rawIds, efforts }
}

/**
 * The GPT-5 level the GPT-5.1 guide says still uses reasoning tokens, where
 * `none` does not ("Unlike GPT-5's prior `minimal` setting, `none` forces
 * the model to never use reasoning tokens").
 */
export function parseGpt51NoneGuide(markdown: string): string {
  const text = prose(markdown)
  const introduced = /GPT-5\.1 introduces a new reasoning mode: `none`\./.test(
    text,
  )
  const level = text.match(
    /Unlike GPT-5[’']s prior `([a-z]+)` setting, `none` forces the model to never use reasoning tokens/,
  )?.[1]
  if (!introduced || !level || !EFFORTS.includes(level)) {
    throw new Error('openai gpt-5.1 guide: none statement unreadable')
  }
  return level
}

export interface Gpt5SamplingRefusal {
  rawIds: Array<string>
  flags: Array<string>
}

/**
 * The "parameter compatibility" section: the parameters a GPT-5.2 request
 * may carry only at `none`, and the older GPT-5 ids that reject them.
 */
export function parseGpt52SamplingGuide(markdown: string): Gpt5SamplingRefusal {
  const section = prose(markdown).match(
    /^### GPT-5\.2 parameter compatibility\s*\n([\s\S]*?)(?=^#{1,3} |(?![\s\S]))/m,
  )?.[1]
  const params = section?.match(
    /only supported\*\* when using GPT-5\.2 with reasoning effort set to `none`:\s*\n((?:\s*- `[a-z_]+`\s*\n)+)/,
  )?.[1]
  const rawIds = codeList(
    section?.match(
      /or to older GPT-5 models \(for example, ([^)]+)\) that include these fields will raise an error\./,
    )?.[1] ?? '',
  )
  const flags = [...(params ?? '').matchAll(/`([a-z_]+)`/g)].flatMap((m) => {
    const flag = SAMPLING_FLAGS[m[1] ?? '']
    return flag ? [flag] : []
  })
  if (!rawIds || !flags.includes('temperature')) {
    throw new Error('openai gpt-5.2 guide: parameter compatibility unreadable')
  }
  return { rawIds, flags }
}

/** Load one guide through the `cached` that `tryDocs` hands over. */
export function loadGuide<T>(
  cached: typeof cachedDocs,
  kv: KVNamespace | undefined,
  url: string,
  parse: (markdown: string) => T,
): Promise<{ parsed: T; hash: string }> {
  return cached(kv, url, async () => {
    const markdown = await fetchText(url, {
      signal: AbortSignal.timeout(20_000),
    })
    return { parsed: parse(markdown), hash: await sha256Text(markdown) }
  })
}
