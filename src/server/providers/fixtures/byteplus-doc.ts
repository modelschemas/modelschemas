/**
 * A docs.byteplus.com page as the doc center renders it: `_ROUTER_DATA`
 * embedding a Lark doc. Each block is a text line (`## ` makes it a
 * heading) or a table of cell strings, header row first.
 */
export function docFixtureHtml(
  blocks: Array<string | Array<Array<string>>>,
): string {
  const ops: Array<unknown> = []
  const data: Record<string, unknown> = { '0': { ops } }
  blocks.forEach((block, t) => {
    if (typeof block === 'string') {
      const heading = block.startsWith('## ')
      ops.push(
        { insert: '*', attributes: heading ? { heading: 'h2' } : {} },
        { insert: `${block.replace(/^## /, '')}\n` },
      )
      return
    }
    ops.push({ insert: '*', attributes: { aceTable: `rows${t} cols${t}` } })
    data[`rows${t}`] = {
      ops: block.map((_, index) => ({ insert: { id: `t${t}r${index}` } })),
      zoneType: 'R',
    }
    data[`cols${t}`] = {
      ops: (block[0] ?? []).map((_, index) => ({
        insert: { id: `t${t}c${index}` },
      })),
      zoneType: 'C',
    }
    block.forEach((cells, row) => {
      cells.forEach((text, column) => {
        data[`xt${t}r${row}xt${t}c${column}`] = {
          ops: [
            { insert: '*', attributes: { lmkr: '1' } },
            { insert: `${text}\n` },
          ],
        }
      })
    })
  })
  const router = {
    loaderData: { page: { curDoc: { Content: JSON.stringify({ data }) } } },
  }
  return `<script>window._ROUTER_DATA = ${JSON.stringify(router)}</script>`
}
