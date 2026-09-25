/**
 * Claude thinking configuration and Anthropic-hosted tools (issue #77).
 *
 * Thinking: the Models API capability tree states which `thinking.type`s a
 * model accepts and its effort levels, but not whether thinking can be
 * turned off. The troubleshooting page's per-model table does ("Default:
 * Always on"), keyed by display name. A parse of zero rows throws.
 *
 * Tools: the tool pages state model support in prose that differs page
 * to page, so the table below is hand-written from them. Types the tool
 * reference lists with no model limit apply to every listed model.
 */
import { assertParsed, cachedDocs, markdownTableRows } from './model-facts.ts'
import { fetchText, sha256Text } from './types.ts'
import type { FactSource, ModelFactSources, ModelReasoning } from './types.ts'

export const ANTHROPIC_THINKING_URL =
  'https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting.md'

const TOOL_DOCS = 'https://platform.claude.com/docs/en/agents-and-tools'

/** Display name (lowercased) → thinking cannot be turned off. */
export function parseThinkingTable(markdown: string): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const [model = '', types, defaultCell] of markdownTableRows(markdown)) {
    if (!model.startsWith('Claude ') || !types || !defaultCell) continue
    out.set(model.toLowerCase(), defaultCell.trim() === 'Always on')
  }
  return out
}

interface Supported {
  supported?: boolean
}

export interface AnthropicThinkingCaps {
  thinking?: Supported & {
    types?: { enabled?: Supported; adaptive?: Supported }
  }
  effort?: Supported & Record<string, unknown>
}

/**
 * `adaptive` wins when both are accepted: extended (`budget_tokens`) is
 * deprecated on the models that still take it.
 */
export function anthropicReasoning(
  caps: AnthropicThinkingCaps | undefined,
  alwaysOn: boolean,
): ModelReasoning | null {
  const types = caps?.thinking?.types
  if (!caps?.thinking?.supported || !types) return null
  const mode = types.adaptive?.supported
    ? 'adaptive'
    : types.enabled?.supported
      ? 'budget'
      : null
  if (!mode) return null
  const efforts = Object.entries(caps.effort ?? {})
    .filter(
      ([, value]) =>
        typeof value === 'object' &&
        value !== null &&
        (value as Supported).supported === true,
    )
    .map(([level]) => level)
  return {
    mode,
    mandatory: alwaysOn,
    ...(efforts.length > 0 ? { efforts } : {}),
  }
}

/** Every listed model (the tool reference names no model limit). */
const ANY = null

// ponytail: hand-written from the tool pages on 2026-09-25. New models get only the
// unrestricted types until a row names them; re-verify on each launch.
const TOOLS: Array<{
  types: Array<string>
  models: Array<string> | null
  page: string
}> = [
  {
    types: [
      'web_search_20250305',
      'web_search_20260209',
      'web_search_20260318',
    ],
    models: ANY,
    page: 'tool-use/web-search-tool',
  },
  {
    types: ['web_fetch_20250910'],
    models: ANY,
    page: 'tool-use/web-fetch-tool',
  },
  {
    // "Dynamic filtering is available with Claude Fable 5.1, …"
    types: ['web_fetch_20260209', 'web_fetch_20260309', 'web_fetch_20260318'],
    models: [
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
    ],
    page: 'tool-use/web-fetch-tool',
  },
  {
    // "Every supported model accepts all three tool versions."
    types: [
      'code_execution_20250825',
      'code_execution_20260120',
      'code_execution_20260521',
    ],
    models: [
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
    ],
    page: 'tool-use/code-execution-tool',
  },
  {
    // Executors in the model-compatibility table.
    types: ['advisor_20260301'],
    models: [
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-fable-5-1',
      'claude-mythos-5-1',
    ],
    page: 'tool-use/advisor-tool',
  },
  {
    types: [
      'tool_search_tool_regex_20251119',
      'tool_search_tool_bm25_20251119',
    ],
    models: [
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
    ],
    page: 'tool-use/tool-search-tool',
  },
  { types: ['mcp_toolset'], models: ANY, page: 'mcp-connector' },
  // "available on all Claude 4 and later models"
  { types: ['memory_20250818'], models: ANY, page: 'tool-use/memory-tool' },
  { types: ['bash_20250124'], models: ANY, page: 'tool-use/bash-tool' },
  // "`text_editor_20250728` is for Claude 4 and later models"
  {
    types: ['text_editor_20250728'],
    models: ANY,
    page: 'tool-use/text-editor-tool',
  },
  {
    types: ['computer_toolset_20260801'],
    models: [
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
    ],
    page: 'tool-use/computer-use-tool',
  },
  {
    // Claude 5.5 and later reject it on the Claude API.
    types: ['computer_20251124'],
    models: [
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-5-20251101',
    ],
    page: 'tool-use/computer-use-tool',
  },
  {
    types: ['computer_20250124'],
    models: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'],
    page: 'tool-use/computer-use-tool',
  },
  {
    types: ['browser_toolset_20260801'],
    models: [
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
    ],
    page: 'tool-use/browser-use-tool',
  },
]

/** Tool type ids a Claude model accepts, each with its docs page. */
export function anthropicServerTools(rawId: string): {
  serverTools: Array<string>
  sources: Record<string, FactSource>
} {
  const serverTools: Array<string> = []
  const sources: Record<string, FactSource> = {}
  for (const row of TOOLS) {
    if (row.models && !row.models.includes(rawId)) continue
    for (const type of row.types) {
      serverTools.push(type)
      sources[type] = {
        derivation: 'docs-derived',
        sourceUrl: `${TOOL_DOCS}/${row.page}`,
        path: `serverTools.${type}`,
      }
    }
  }
  return { serverTools, sources }
}

/** Reasoning + server tools for one listed model, with provenance. */
export async function anthropicModelFeatures(kv?: KVNamespace) {
  const doc = await cachedDocs(kv, ANTHROPIC_THINKING_URL, async () => {
    const markdown = await fetchText(ANTHROPIC_THINKING_URL)
    const parsed = parseThinkingTable(markdown)
    assertParsed(parsed, 'anthropic thinking table')
    return {
      alwaysOn: Object.fromEntries(parsed),
      hash: await sha256Text(markdown),
    }
  })
  return (
    rawId: string,
    displayName: string | null | undefined,
    caps: AnthropicThinkingCaps | undefined,
  ) => {
    const key = (displayName ?? '').trim().toLowerCase()
    const listed = doc.alwaysOn[key]
    const reasoning = anthropicReasoning(caps, listed ?? false)
    const { serverTools, sources } = anthropicServerTools(rawId)
    const factSources: ModelFactSources = { serverTools: sources }
    if (reasoning) {
      // Mode and efforts are the listing's; `mandatory` needs the docs row.
      factSources.reasoning =
        listed === undefined
          ? { derivation: 'listing' }
          : {
              derivation: 'docs-derived',
              sourceUrl: ANTHROPIC_THINKING_URL,
              sourceHash: doc.hash,
              path: key,
            }
    }
    return { reasoning, serverTools, factSources }
  }
}
