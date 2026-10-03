/**
 * Provider-hosted tool type ids (issue #123). A page that does not name a
 * type id for a model contributes nothing. Grok and OpenRouter are not
 * parsed here: xAI publishes no per-model list, and OpenRouter ids are
 * router-level.
 */
import { tagDocsFacts } from './fact-sources.ts'
import { cachedDocs, markdownTableRows } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

export const GROQ_BUILTIN_TOOLS_URL =
  'https://console.groq.com/docs/tool-use/built-in-tools.md'

type HostedFacts = Pick<ModelInfo, 'serverTools' | 'factSources'>

function unescapeDocs(markdown: string): string {
  return markdown.replace(/\\([_`])/g, '$1')
}

/**
 * Built-in tools page: each `###` section names model ids in bullets and
 * tool type ids in an Identifier column. Sections that name neither stay
 * out of the map.
 */
export function parseGroqBuiltinTools(
  markdown: string,
): Map<string, Array<string>> {
  const out = new Map<string, Array<string>>()
  const text = unescapeDocs(markdown)
  for (const section of text.split(/\n### /).slice(1)) {
    const rows = markdownTableRows(section)
    const header = rows.find((row) =>
      row.some((cell) => /^identifier$/i.test(cell)),
    )
    const column = header?.findIndex((cell) => /^identifier$/i.test(cell)) ?? -1
    if (!header || column < 0) continue
    const tools = [
      ...new Set(
        rows
          .filter((row) => row !== header)
          .flatMap((row) => {
            const id = row[column]?.trim() ?? ''
            return /^[a-z][a-z0-9_]*$/.test(id) ? [id] : []
          }),
      ),
    ]
    if (tools.length === 0) continue
    const toolSet = new Set(tools)
    for (const match of section.matchAll(/^[*+-]\s+`([^`]+)`/gm)) {
      const id = match[1]?.trim() ?? ''
      if (id.length === 0 || toolSet.has(id) || id.startsWith('http')) continue
      out.set(id, tools)
    }
  }
  return out
}

/** Lookup from the built-in tools page. A fetch or empty parse leaves tools unset. */
export async function groqModelServerTools(
  kv?: KVNamespace,
): Promise<(rawId: string) => HostedFacts> {
  try {
    const doc = await cachedDocs(kv, GROQ_BUILTIN_TOOLS_URL, async () => {
      const markdown = await fetchText(GROQ_BUILTIN_TOOLS_URL)
      const parsed = parseGroqBuiltinTools(markdown)
      return {
        tools: Object.fromEntries(parsed),
        hash: await sha256Text(markdown),
      }
    })
    return (rawId) => {
      const tools = doc.tools[rawId]
      if (!tools || tools.length === 0) return {}
      return {
        serverTools: tools,
        factSources: tagDocsFacts(
          { serverTools: tools },
          GROQ_BUILTIN_TOOLS_URL,
          doc.hash,
        ),
      }
    }
  } catch {
    return () => ({})
  }
}

const CLIENT_TOOL = 'function'

/**
 * Tool type ids a Mistral model page names under Supported tools or
 * Built-in tools. `function` is a client tool. Nav and scripts are not
 * the model page.
 */
export function parseMistralPageTools(html: string): Array<string> {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<code>([^<]+)<\/code>/gi, '`$1`')
    .replace(/<[^>]+>/g, ' ')
  const start = text.search(/supported tools|built-in tools/i)
  if (start < 0) return []
  const section = text.slice(start, start + 2500)
  const ids = [
    ...section.matchAll(/`([a-z][a-z0-9_]*)`/g),
    ...section.matchAll(/"type"\s*:\s*"([a-z][a-z0-9_]*)"/g),
  ].flatMap((match) => {
    const id = match[1] ?? ''
    return id.length > 0 && id !== CLIENT_TOOL ? [id] : []
  })
  return [...new Set(ids)]
}

/**
 * Ark docs: a `##` section that names catalog ids and a `tools` entry's
 * `type` assigns those ids. A section that only says a capability is not
 * supported does not.
 */
export function parseByteplusServerTools(
  doc: string,
): Map<string, Array<string>> {
  const out = new Map<string, Array<string>>()
  const text = doc.replace(/\\n/g, '\n').replace(/\\"/g, '"')
  for (const section of text.split(/\n## /).slice(1)) {
    if (
      /not currently supported/i.test(section) &&
      !/"type"\s*:/.test(section)
    ) {
      continue
    }
    const tools = [
      ...new Set(
        [
          ...section.matchAll(
            /tools[\s\S]{0,400}?"type"\s*:\s*"([a-z][a-z0-9_]*)"/g,
          ),
        ].flatMap((match) => (match[1] ? [match[1]] : [])),
      ),
    ]
    if (tools.length === 0) continue
    for (const match of section.matchAll(
      /`([a-z0-9][a-z0-9.-]*\d[a-z0-9.-]*)`/g,
    )) {
      const id = match[1]
      if (id) out.set(id, tools)
    }
  }
  return out
}
