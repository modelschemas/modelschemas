/**
 * BytePlus server-side tools (#409). The ModelArk model list has a "Tool
 * use" table, one row per model, with an MCP column; the cloud-deployed /
 * remote MCP guide's "Supported models" points at it. A `Supported` or
 * `Yes` cell (the wording served on 2026-10-23) is the `mcp` tool type.
 */
import { fetchByteplusDoc } from './byteplus-docs.ts'
import {
  BYTEPLUS_MODEL_LIST_URL,
  pricingContent,
  tablesWith,
} from './byteplus-pricing.ts'
import type { ByteplusDoc } from './byteplus-pricing.ts'
import { tryDocs, unavailable } from './model-facts.ts'
import type { DocsRun } from './model-facts.ts'
import { sha256Text } from './types.ts'
import type { ModelInfo } from './types.ts'

/**
 * Model id → whether the model list's Tool use table marks MCP supported.
 * No such table, or a cell other than Supported or Yes, Not Supported or
 * No, throws. An id the table lists twice with different answers is dropped.
 */
export function parseByteplusMcpSupport(
  doc: ByteplusDoc,
): Map<string, boolean> {
  const tables = tablesWith(doc, ['model id']).filter((table) =>
    table.keys.some((key) => key.startsWith('mcp')),
  )
  if (tables.length === 0) {
    throw new Error('byteplus model list: no Tool use table with an MCP column')
  }
  const out = new Map<string, boolean>()
  const conflicts = new Set<string>()
  for (const { keys, rows } of tables) {
    const idAt = keys.indexOf('model id')
    const mcpAt = keys.findIndex((key) => key.startsWith('mcp'))
    for (const row of rows) {
      const id = /^[a-z0-9][a-z0-9.-]*/.exec(row[idAt] ?? '')?.[0]
      const cell = (row[mcpAt] ?? '').trim()
      const supported = /^(supported|yes)$/i.test(cell)
        ? true
        : /^(not supported|no)$/i.test(cell)
          ? false
          : null
      if (!id || supported === null) {
        throw new Error(
          `byteplus model list: unread Tool use row ${JSON.stringify(row)}`,
        )
      }
      const prior = out.get(id)
      if (prior !== undefined && prior !== supported) conflicts.add(id)
      out.set(id, supported)
    }
  }
  for (const id of conflicts) out.delete(id)
  return out
}

type HostedFacts = Pick<ModelInfo, 'serverTools' | 'factSources' | 'absent'>

/**
 * `mcp` for each model the Tool use table marks supported. When the page
 * fails to load, every row keeps its stored tools (`unavailable`), and the
 * failure is in `docsFailures`.
 */
export async function byteplusServerTools(
  run: DocsRun,
  kv?: KVNamespace,
): Promise<(rawId: string) => HostedFacts> {
  const doc = await tryDocs(run, BYTEPLUS_MODEL_LIST_URL, (cached) =>
    cached(kv, BYTEPLUS_MODEL_LIST_URL, async () => {
      const content = pricingContent(
        await fetchByteplusDoc(BYTEPLUS_MODEL_LIST_URL),
        'byteplus model list',
      )
      return {
        mcp: Object.fromEntries(
          parseByteplusMcpSupport(JSON.parse(content) as ByteplusDoc),
        ),
        hash: await sha256Text(content),
      }
    }),
  )
  return (rawId) => {
    if (!doc) return unavailable('serverTools')
    if (doc.mcp[rawId] !== true) return {}
    return {
      serverTools: ['mcp'],
      factSources: {
        serverTools: {
          mcp: {
            derivation: 'docs-derived',
            sourceUrl: BYTEPLUS_MODEL_LIST_URL,
            sourceHash: doc.hash,
            path: 'Tool use table: MCP',
          },
        },
      },
    }
  }
}
