/**
 * A docs.mistral.ai model page cut down to what ingest reads from its RSC
 * payload: the API ids and the block beside the "Modalities" heading. The
 * shapes are copied from the live pages (2026-10-07).
 */

/** One modality tooltip: an `asChild` trigger and the label component. */
export function tip(label: unknown, contentProps: object = {}): unknown {
  return [
    '$',
    '$L4f',
    'k',
    {
      children: [
        [
          '$',
          '$L50',
          null,
          { asChild: true, children: ['$', 'span', null, {}] },
        ],
        ['$', '$L51', null, { ...contentProps, children: label }],
      ],
    },
  ]
}

/** Each block is one "Modalities" heading with its tooltips in a lazy row. */
export function mistralModelPage(
  ids: Array<string>,
  blocks: Array<Array<unknown>>,
  extraRows: Record<string, unknown> = {},
): string {
  const heading = [
    '$',
    'span',
    null,
    { children: [['$', 'svg', null, {}], 'Modalities'] },
  ]
  const rows: Record<string, unknown> = {
    '1': [
      '$',
      'div',
      null,
      {
        children: [
          ['$', '$L1d', null, { names: ids, maxVisible: 1 }],
          ['$', 'span', null, { children: 'Max output' }],
          ...blocks.map((_, index) => [
            '$',
            'div',
            null,
            { children: [heading, `$Lb${String(index)}`] },
          ]),
        ],
      },
    ],
    ...Object.fromEntries(
      blocks.map((tooltips, index) => [
        `b${String(index)}`,
        [
          '$',
          'div',
          null,
          { children: [['$', 'div', null, { children: tooltips }]] },
        ],
      ]),
    ),
    ...extraRows,
  }
  const stream = Object.entries(rows)
    .map(([id, row]) => `${id}:${JSON.stringify(row)}\n`)
    .join('')
  return `<html><script>self.__next_f.push([1,${JSON.stringify(stream)}])</script></html>`
}

/** The web search guide's lines ingest reads (as served 2026-10-22). */
export const MISTRAL_WEBSEARCH_GUIDE = `# Websearch

Our built-in [tool](/studio/agents/agent-tools#built-in-tools) for websearch allows any of our models to access the web at any point to search websites and sources for relevant information to answer the given query.

There are two versions:
- \`web_search\`: A simple web search tool that enables access to a search engine.
- \`web_search_premium\`: A more complex web search tool that enables access to both a search engine and to news articles via integrated news provider verification.

:::warning
\`web_search\` and \`web_search_premium\` work with the [Conversations API](/studio/connectors/conversations) (\`/v1/conversations\`) and the Agents API. They aren't **supported** in the Chat Completions API (\`/v1/chat/completions\`).
:::
`
