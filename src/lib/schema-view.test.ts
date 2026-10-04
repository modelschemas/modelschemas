import { describe, expect, it } from 'vitest'

import { schemaToRows } from '#/lib/schema-view.ts'

describe('schemaToRows', () => {
  it('links a property type to its $def and lists that definition', () => {
    const table = schemaToRows({
      type: 'object',
      properties: {
        item: { $ref: '#/$defs/CreateContentGenerationContentItem' },
      },
      required: ['item'],
      $defs: {
        CreateContentGenerationContentItem: {
          type: 'object',
          properties: {
            type: { type: 'string' },
          },
          required: ['type'],
        },
      },
    })

    expect(table.rows[0]?.typeLabel).toBe('CreateContentGenerationContentItem')
    expect(table.rows[0]?.typeRefs).toEqual([
      'CreateContentGenerationContentItem',
    ])
    expect(table.definitions.map((def) => def.name)).toEqual([
      'CreateContentGenerationContentItem',
    ])
    expect(table.definitions[0]?.children.map((row) => row.name)).toEqual([
      'type',
    ])
  })

  it('prefers the longer $def name when one name contains another', () => {
    const table = schemaToRows({
      type: 'object',
      properties: {
        item: { $ref: '#/$defs/ContentItem' },
      },
      $defs: {
        Content: { type: 'string' },
        ContentItem: {
          type: 'object',
          properties: { text: { type: 'string' } },
        },
      },
    })
    expect(table.rows[0]?.typeRefs).toEqual(['ContentItem'])
  })
})
