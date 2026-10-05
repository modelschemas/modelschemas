/**
 * Bedrock Runtime Converse as OpenAPI (issue #153). AWS publishes no OpenAPI
 * document, so the spec is generated at sync time from the service model the
 * AWS SDK for Python ships (botocore `service-2.json`): every shape becomes a
 * component schema and Converse becomes one POST path. InvokeModel is left
 * out — its body is an opaque blob whose shape belongs to each model maker.
 */
import { BEDROCK_CONVERSE_PATH } from './bedrock-cards.ts'
import { PROVENANCE_MARKER } from './types.ts'
import type { OpenApiDocument } from './types.ts'

export const BEDROCK_SDK_MODEL_URL =
  'https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/bedrock-runtime/2023-09-30/service-2.json'

const REF = '#/components/schemas/'

interface Member {
  shape: string
  documentation?: string
  /** `uri` / `header` / `querystring`: not part of the JSON body. */
  location?: string
}

interface Shape {
  type: string
  members?: Record<string, Member>
  required?: Array<string>
  member?: Member
  value?: Member
  enum?: Array<string>
  min?: number
  max?: number
  documentation?: string
  /** Tagged union: exactly one member is set. */
  union?: boolean
  /** Free-form JSON value. */
  document?: boolean
  exception?: boolean
}

export interface BedrockServiceModel {
  operations: Record<
    string,
    {
      http: { method: string; requestUri: string }
      input?: { shape: string }
      output?: { shape: string }
      documentation?: string
    }
  >
  shapes: Record<string, Shape>
}

type Schema = Record<string, unknown>

function prose(html: string | undefined): string | undefined {
  const text = html
    ?.replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? undefined : text
}

function described(schema: Schema, html: string | undefined): Schema {
  const description = prose(html)
  return description ? { ...schema, description } : schema
}

const ref = (member: Member): Schema =>
  described({ $ref: REF + member.shape }, member.documentation)

function range(shape: Shape, min: string, max: string): Schema {
  return {
    ...(shape.min !== undefined ? { [min]: shape.min } : {}),
    ...(shape.max !== undefined ? { [max]: shape.max } : {}),
  }
}

function shapeSchema(shape: Shape): Schema {
  switch (shape.type) {
    case 'structure': {
      if (shape.document) return {}
      const body = Object.entries(shape.members ?? {}).filter(
        ([, member]) => member.location === undefined,
      )
      const required = (shape.required ?? []).filter((name) =>
        body.some(([key]) => key === name),
      )
      return {
        type: 'object',
        properties: Object.fromEntries(
          body.map(([name, member]) => [name, ref(member)]),
        ),
        ...(required.length > 0 ? { required } : {}),
        ...(shape.union ? { minProperties: 1, maxProperties: 1 } : {}),
      }
    }
    case 'list':
      return {
        type: 'array',
        ...(shape.member ? { items: ref(shape.member) } : {}),
        ...range(shape, 'minItems', 'maxItems'),
      }
    case 'map':
      return {
        type: 'object',
        ...(shape.value ? { additionalProperties: ref(shape.value) } : {}),
      }
    case 'string':
      // `pattern` is dropped: the SDK's regexes are not all ECMAScript.
      return {
        type: 'string',
        ...(shape.enum ? { enum: shape.enum } : {}),
        ...range(shape, 'minLength', 'maxLength'),
      }
    case 'blob':
      return { type: 'string', contentEncoding: 'base64' }
    case 'integer':
    case 'long':
      return { type: 'integer', ...range(shape, 'minimum', 'maximum') }
    case 'float':
    case 'double':
      return { type: 'number', ...range(shape, 'minimum', 'maximum') }
    case 'boolean':
      return { type: 'boolean' }
    case 'timestamp':
      return { type: 'string', format: 'date-time' }
    default:
      throw new Error(`amazon-bedrock SDK model: shape type "${shape.type}"`)
  }
}

/** The SDK service model → an OpenAPI document with the Converse path. */
export function bedrockConverseSpec(
  model: BedrockServiceModel,
): OpenApiDocument {
  const converse = Object.values(model.operations).find(
    (op) => op.http.requestUri === BEDROCK_CONVERSE_PATH,
  )
  if (!converse?.input || !converse.output) {
    throw new Error('amazon-bedrock SDK model: no Converse operation')
  }
  const json = (shape: string) => ({
    'application/json': { schema: { $ref: REF + shape } },
  })
  return {
    openapi: '3.1.0',
    info: { title: 'Amazon Bedrock Runtime', version: '2023-09-30' },
    paths: {
      [BEDROCK_CONVERSE_PATH]: {
        post: {
          operationId: 'Converse',
          ...described({}, converse.documentation),
          [PROVENANCE_MARKER]: { derivation: 'generated' },
          parameters: [
            {
              name: 'modelId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: { required: true, content: json(converse.input.shape) },
          responses: {
            '200': { description: 'OK', content: json(converse.output.shape) },
          },
        },
      },
    },
    components: {
      schemas: Object.fromEntries(
        Object.entries(model.shapes)
          .filter(([, shape]) => !shape.exception)
          .map(([name, shape]) => [
            name,
            described(shapeSchema(shape), shape.documentation),
          ]),
      ),
    },
  }
}
