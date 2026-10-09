import { expect, it } from 'vitest'
import docs from './fixtures/cloudflare-native-final-controls.json'
import { parseCatalogModel } from './adapters/cloudflare-ai-gateway.ts'

const source = {
  url: 'https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/catalog-models/',
  hash: 'native-fixture',
  extractedAt: '2026-10-09T00:00:00.000Z',
}
it('sources adaptive mode, operational always-on semantics and accepted efforts from exact owned Opus card', () => {
  const doc = docs[0]!
  expect(doc.description).toContain('adaptive thinking that is always on')
  const result = parseCatalogModel(doc, source, { schemaShared: true })
  expect(result.reasoning).toEqual({
    mode: 'adaptive',
    mandatory: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  })
  expect(result.requestMap?.thinking?.off).toBeNull()
  expect(result.factSources?.reasoning?.sourceUrl).toBe(source.url)
  const noDeclaration = { ...doc, metadata: { Architecture: 'Transformer' } }
  expect(
    parseCatalogModel(noDeclaration, source, { schemaShared: true }).reasoning,
  ).toBeUndefined()
  const withoutControl = structuredClone(doc)
  delete (withoutControl.schema.input.properties as Record<string, unknown>)
    .thinking
  expect(
    parseCatalogModel(withoutControl, source, { schemaShared: true }).reasoning,
  ).toBeUndefined()
})
it('sources only the exact owned Responses reasoning field without inferring mandatory or off', () => {
  const doc = docs[1]!
  const result = parseCatalogModel(doc, source, { schemaShared: true })
  expect(result.reasoning).toEqual({
    mode: 'effort',
    mandatory: null,
    efforts: ['low', 'medium', 'high'],
  })
  expect(result.requestMap?.thinking?.off).toBeNull()
  for (const changed of [
    { ...doc, metadata: {} },
    { ...doc, tags: [] },
  ])
    expect(
      parseCatalogModel(changed, source, { schemaShared: true }).reasoning,
    ).toBeUndefined()
  const qualified = structuredClone(doc)
  Object.assign(
    qualified.schema.input.properties.reasoning!.properties.effort,
    {
      description: 'Availability and accepted values are model-dependent.',
    },
  )
  expect(
    parseCatalogModel(qualified, source, { schemaShared: true }).reasoning,
  ).toBeUndefined()
  expect(
    parseCatalogModel(
      { ...doc, metadata: { ...doc.metadata, Reasoning: 'No' } },
      source,
      { schemaShared: true },
    ).reasoning,
  ).toBeUndefined()
})
