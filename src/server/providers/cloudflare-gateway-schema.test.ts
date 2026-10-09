import { expect, it } from 'vitest'
import {
  catalogGatewayEndpoint,
  parseGatewayRunContract,
} from './cloudflare-gateway-schema.ts'

const source = {
  url: 'https://developers.cloudflare.com/native-fixture',
  hash: 'a'.repeat(64),
}
const docs =
  '| `POST /ai/run` | Envelope with `model`, `input` |\nModel-specific parameters go inside `input`.\ncurl -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run"'
const contract = parseGatewayRunContract(docs, source)
const info = { rawId: 'author/model', activity: 'chat' as const }
it('uses the sourced universal path with a logical model identity and unchanged native inputs', () => {
  const input = {
    type: 'object',
    properties: { max_tokens: { type: 'integer', minimum: 1 } },
    required: ['max_tokens'],
  }
  const endpoint = catalogGatewayEndpoint(
    { schema: { input, output: { type: 'string' } } },
    info,
    source,
    contract,
  )
  expect(endpoint).toMatchObject({
    publicId: 'author/model',
    path: '/accounts/{account_id}/ai/run',
    activity: 'chat',
    source,
    derivation: 'generated',
  })
  expect(endpoint?.input).toEqual({
    type: 'object',
    properties: { model: { type: 'string', const: 'author/model' }, input },
    'x-modelschemas-envelope-source': source,
  })
  expect(endpoint?.output).toBeUndefined()
  expect(endpoint?.input).not.toHaveProperty('required')
})
it('does not guess unknown activities or manufacture missing schema bodies', () => {
  expect(
    catalogGatewayEndpoint(
      { schema: { input: { type: 'object' } } },
      { ...info, activity: null },
      source,
      contract,
    ),
  ).toBeNull()
  expect(
    catalogGatewayEndpoint({ schema: { input: {} } }, info, source, contract),
  ).toBeNull()
  expect(catalogGatewayEndpoint({}, info, source, contract)).toBeNull()
})
it('rebases internal references into the model input without changing their target', () => {
  const endpoint = catalogGatewayEndpoint(
    {
      schema: {
        input: {
          $defs: { Text: { type: 'string' } },
          properties: { prompt: { $ref: '#/$defs/Text' } },
        },
      },
    },
    info,
    source,
    contract,
  )
  expect(endpoint?.input).toMatchObject({
    properties: {
      input: {
        properties: { prompt: { $ref: '#/properties/input/$defs/Text' } },
      },
    },
  })
})
it('rejects ambiguous schema scopes and external refs', () => {
  expect(() =>
    catalogGatewayEndpoint(
      { schema: { input: { $id: 'https://native/schema', type: 'object' } } },
      info,
      source,
      contract,
    ),
  ).toThrow('scoped input $id')
  expect(() =>
    catalogGatewayEndpoint(
      { schema: { input: { $ref: 'https://native/schema' } } },
      info,
      source,
      contract,
    ),
  ).toThrow('external reference')
})
it('rejects changed or missing native envelope and POST evidence', () => {
  expect(() =>
    parseGatewayRunContract(docs.replace('Envelope with', 'Other'), source),
  ).toThrow('no model/input envelope')
  expect(() =>
    parseGatewayRunContract(
      docs.replace('curl -X POST', 'curl -X GET'),
      source,
    ),
  ).toThrow('no universal POST path')
})
