import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parseCohereModelTable } from './cohere-model-docs.ts'

// The Command, North, Embed and Aya sections of
// https://docs.cohere.com/docs/models.md, fetched 2026-10-07.
const PAGE = readFileSync(
  new URL('./fixtures/cohere-models.md.txt', import.meta.url),
  'utf8',
)

describe('cohere models page', () => {
  const rows = parseCohereModelTable(PAGE)

  it('reads the output cap and input modalities of each chat row', () => {
    expect(rows.get('command-a-plus-05-2026')).toEqual({
      live: true,
      input: ['text', 'image'],
      maxOutput: 64000,
    })
    expect(rows.get('command-a-03-2025')).toEqual({
      live: true,
      input: ['text'],
      maxOutput: 8000,
    })
    expect(rows.get('command-a-reasoning-08-2025')?.maxOutput).toBe(32000)
    expect(rows.get('command-a-vision-07-2025')).toEqual({
      live: true,
      input: ['text', 'image'],
      maxOutput: 8000,
    })
    expect(rows.get('north-mini-code-1-0')?.maxOutput).toBe(64000)
    expect(rows.get('c4ai-aya-vision-32b')?.input).toEqual(['text', 'image'])
    expect(rows.get('tiny-aya-fire')?.maxOutput).toBe(8000)
  })

  it('marks only `Live` rows live', () => {
    expect(rows.get('command-r-08-2024')?.live).toBe(true)
    expect(rows.get('command-r-03-2024')?.live).toBe(false)
    expect(rows.get('c4ai-aya-expanse-8b')?.live).toBe(false)
  })

  it('skips tables without the chat columns', () => {
    expect(rows.has('embed-v4.0')).toBe(false)
    expect(rows.has('command-r-plus')).toBe(true)
    expect(rows.size).toBe(24)
  })

  it('drops a row whose cells are reworded rather than guessing', () => {
    const row = (modality: string, output: string, endpoint: string) =>
      [
        '| Model Name | Status | Description | Modality | Context Length | Maximum Output Tokens | Endpoints |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        `| \`command-x-01-2027\` | Live | New | ${modality} | 256k | ${output} | ${endpoint} |`,
      ].join('\n')
    const chat = '[Chat](../reference/chat)'
    expect(parseCohereModelTable(row('Text', '8k', chat)).size).toBe(1)
    expect(parseCohereModelTable(row('Text, Audio', '8k', chat)).size).toBe(0)
    expect(parseCohereModelTable(row('Text', '8,192', chat)).size).toBe(0)
    expect(parseCohereModelTable(row('Text', 'up to 8k', chat)).size).toBe(0)
    expect(parseCohereModelTable(row('Text', '8k (32k beta)', chat)).size).toBe(
      0,
    )
    expect(
      parseCohereModelTable(row('Text', '8k', '[Embed](../reference/embed)'))
        .size,
    ).toBe(0)
    // A renamed column takes the whole table with it.
    expect(
      parseCohereModelTable(
        row('Text', '8k', chat).replace('Maximum Output Tokens', 'Max Output'),
      ).size,
    ).toBe(0)
    // A 200 "Page Not Found" body has no table.
    expect(parseCohereModelTable('# Page Not Found\n').size).toBe(0)
  })
})
