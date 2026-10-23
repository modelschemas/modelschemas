import type { ByteplusDoc } from '../byteplus-pricing.ts'

/**
 * One pricing-page table, header row first. `tab` puts it in a tab strip
 * with that title; `folded` puts it in a folded section ("Retiring
 * models"). A merge is `[row indexes, column indexes]`: its text goes in
 * its first cell, the others stay blank.
 */
export interface PricingTable {
  rows: Array<Array<string>>
  tab?: string
  folded?: boolean
  merges?: Array<[Array<number>, Array<number>]>
}

/**
 * The ModelArk pricing page's Lark doc as docs.byteplus.com embeds it on
 * 2026-10-23: tables in zone `0`, in a `tabsZoneId` strip of `tabContent`
 * zones, or in a folded `zoneId` section; merged cells listed by
 * `mergeCellID` on their rows and columns.
 */
export function pricingDoc(tables: Array<PricingTable>): ByteplusDoc {
  const top: Array<{ insert: string; attributes: Record<string, string> }> = []
  const data: ByteplusDoc['data'] = { '0': { ops: top } }
  tables.forEach(({ rows, tab, folded, merges = [] }, t) => {
    const table = { insert: '*', attributes: { aceTable: `rows${t} cols${t}` } }
    let placed: { insert: string; attributes: Record<string, string> } = table
    if (tab !== undefined) {
      data[`tabs${t}`] = {
        ops: [
          {
            insert: ' ',
            attributes: { tabContent: 'true', title: tab, zoneId: `pane${t}` },
          },
        ],
      }
      data[`pane${t}`] = { ops: [table] }
      placed = { insert: ' ', attributes: { tabsZoneId: `tabs${t}` } }
    }
    if (folded) {
      data[`fold${t}`] = { ops: [placed] }
      placed = {
        insert: ' ',
        attributes: { collapse: 'container', zoneId: `fold${t}` },
      }
    }
    top.push(placed)
    const line = (prefix: string, index: number, side: 0 | 1) => {
      const ids = merges.flatMap((merge, m) =>
        merge[side].includes(index) ? [`m${String(t)}x${String(m)}`] : [],
      )
      return {
        insert: { id: `t${String(t)}${prefix}${String(index)}` },
        ...(ids.length > 0 && { attributes: { mergeCellID: ids.join(',') } }),
      }
    }
    data[`rows${t}`] = {
      ops: rows.map((_, index) => line('r', index, 0)),
      zoneType: 'R',
    }
    data[`cols${t}`] = {
      ops: (rows[0] ?? []).map((_, index) => line('c', index, 1)),
      zoneType: 'C',
    }
    rows.forEach((cells, r) => {
      cells.forEach((text, c) => {
        data[`xt${t}r${r}xt${t}c${c}`] = {
          ops: [
            { insert: '*', attributes: { lmkr: '1' } },
            { insert: `${text}\n` },
          ],
        }
      })
    })
  })
  return { data }
}

/** `doc` inside the page's `window._ROUTER_DATA`. */
export function routerHtml(doc: ByteplusDoc): string {
  const router = {
    loaderData: { page: { curDoc: { Content: JSON.stringify(doc) } } },
  }
  return `<script>window._ROUTER_DATA = ${JSON.stringify(router)}</script>`
}
