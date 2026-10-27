import { describe, expect, it } from 'vitest'

import { openApiDocument } from './openapi.ts'
import { MODEL_ROW_SHAPE, modelRowShapeHash } from './row-shape.ts'

type Schemas = Parameters<typeof modelRowShapeHash>[0]

function schemasCopy(): NonNullable<Schemas> {
  return structuredClone(
    openApiDocument.components.schemas,
  ) as unknown as NonNullable<Schemas>
}

describe('MODEL_ROW_SHAPE', () => {
  it('matches the row schemas in openapi.ts', async () => {
    const hash = await modelRowShapeHash()
    expect(
      hash,
      'The row schemas changed. If a served field changed: bump MODEL_ROW_SHAPE.version, set its hash to this value, rewrite notes, and add a @modelschemas/client changeset (README "API stability"). If only the emitter respelled the same shape: set the hash alone.',
    ).toBe(MODEL_ROW_SHAPE.hash)
  })

  it('changes when a referenced schema changes shape', async () => {
    const schemas = schemasCopy()
    const before = await modelRowShapeHash(schemas)
    const source = schemas.FactSource as {
      properties: Record<string, unknown>
    }
    source.properties.extra = { type: 'string' }
    expect(await modelRowShapeHash(schemas)).not.toBe(before)
  })

  it('ignores a reworded description', async () => {
    const schemas = schemasCopy()
    const before = await modelRowShapeHash(schemas)
    const model = schemas.Model as {
      properties: { releasedAt: { description?: string } }
    }
    model.properties.releasedAt.description = 'Reworded.'
    expect(await modelRowShapeHash(schemas)).toBe(before)
  })
})
