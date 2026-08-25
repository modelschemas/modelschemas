/**
 * The service's own OpenAPI 3.1 document (PLAN.md task 4.1), hand-maintained.
 * Single source of truth for three consumer surfaces: the generated TS client
 * (task 7.4), the CLI (7.5), and the agent-auth capability list (5.1) — every
 * operation MUST carry a unique operationId.
 */

const activityEnum = [
  'chat',
  'image',
  'video',
  'audio',
  'embeddings',
  'moderation',
]

const changeTypeEnum = [
  'model.added',
  'model.removed',
  'model.updated',
  'schema.added',
  'schema.updated',
  'endpoint.added',
  'endpoint.removed',
]

const errorResponse = {
  description: 'Error',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
    },
  },
}

const providerParam = {
  name: 'provider',
  in: 'path',
  required: true,
  description: 'Provider slug (see GET /v1/providers).',
  schema: { type: 'string' },
}

const activityParam = {
  name: 'activity',
  in: 'path',
  required: true,
  description: 'Activity group.',
  schema: { type: 'string', enum: activityEnum },
}

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'modelschemas',
    version: '0.1.0',
    description:
      'Live AI model schema service: per-endpoint request/response JSON ' +
      'Schemas and model metadata for monitored providers, with ' +
      'stale-while-revalidate caching and a change feed. Anonymous reads ' +
      'are allowed at a low rate limit; register (agent-auth or API key) ' +
      'for higher limits and webhook subscriptions.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/v1': {
      get: {
        operationId: 'getServiceIndex',
        summary: 'Service description and endpoint index',
        responses: {
          '200': {
            description: 'Service index with _links to every surface.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/v1/status': {
      get: {
        operationId: 'getStatus',
        summary: 'Per-provider sync status and row counts',
        parameters: [
          {
            name: 'wait',
            in: 'query',
            description:
              'Long-poll: hold up to N seconds (cap 60; "30s" form accepted) until new data exists, then return current data.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Service status.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ServiceStatus' },
              },
            },
          },
        },
      },
    },
    '/v1/providers': {
      get: {
        operationId: 'listProviders',
        summary: 'List monitored providers with sync status',
        responses: {
          '200': {
            description: 'Providers.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/v1/providers/{provider}/models': {
      get: {
        operationId: 'listProviderModels',
        summary: 'List models for one provider',
        parameters: [providerParam],
        responses: {
          '200': {
            description: 'Models for the provider.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '404': errorResponse,
        },
      },
    },
    '/v1/models': {
      get: {
        operationId: 'listModels',
        summary: 'Cross-provider model catalog',
        description:
          'The headline "what can I use right now" endpoint. Filterable.',
        parameters: [
          {
            name: 'activity',
            in: 'query',
            schema: { type: 'string', enum: activityEnum },
          },
          { name: 'provider', in: 'query', schema: { type: 'string' } },
          {
            name: 'capability',
            in: 'query',
            description: 'Substring match against model capabilities.',
            schema: { type: 'string' },
          },
          {
            name: 'q',
            in: 'query',
            description: 'Free-text match against id and display name.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Matching models.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/v1/models/{provider}/{modelId}': {
      get: {
        operationId: 'getModel',
        summary: 'Full metadata for one model',
        parameters: [
          providerParam,
          {
            name: 'modelId',
            in: 'path',
            required: true,
            description: 'Model slug or raw provider id.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description:
              'Model metadata with activity, schemaEndpointId (canonical generation route on grain=provider catalogs), and _links.schema when bound.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '404': errorResponse,
        },
      },
    },
    '/v1/schemas': {
      get: {
        operationId: 'listAllSchemas',
        summary: 'System-wide schema index',
        description:
          'Every provider with extracted schemas, each with its activities and endpoint ids — the discovery entry point for all schemas on the system.',
        responses: {
          '200': {
            description: 'Provider → activity → endpoint-id index.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/v1/schemas/{provider}': {
      get: {
        operationId: 'listProviderSchemas',
        summary: 'Activities and endpoint ids for a provider',
        parameters: [providerParam],
        responses: {
          '200': {
            description: 'Activity → endpoint-id index.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '404': errorResponse,
        },
      },
    },
    '/v1/schemas/{provider}/{activity}': {
      get: {
        operationId: 'getActivitySchemas',
        summary: 'Endpoint-id-keyed schema map for one activity',
        parameters: [providerParam, activityParam],
        responses: {
          '200': {
            description:
              'Map of endpoint id → { input, output } self-contained JSON Schemas (current versions).',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '404': errorResponse,
        },
      },
    },
    '/v1/schemas/{provider}/{activity}/{endpointId}': {
      get: {
        operationId: 'getSchema',
        summary: 'One self-contained JSON Schema',
        parameters: [
          providerParam,
          activityParam,
          {
            name: 'endpointId',
            in: 'path',
            required: true,
            description:
              "Path-derived endpoint id (URL-encode slashes), or a listed model rawId/slug which aliases onto that activity's generation route and pins the request `model` field.",
            schema: { type: 'string' },
          },
          {
            name: 'kind',
            in: 'query',
            description: 'Defaults to input.',
            schema: { type: 'string', enum: ['input', 'output'] },
          },
          {
            name: 'version',
            in: 'query',
            description: 'Content hash of a historical version.',
            schema: { type: 'string' },
          },
          {
            name: 'format',
            in: 'query',
            description:
              'json (default) or types — a self-contained TypeScript module (schema const + generated types, tree-shakeable, zero imports). format=types on an input schema with a model property overlays the live catalog union plus ListedModelId; the schema const and content hash stay the bundled schema.',
            schema: { type: 'string', enum: ['json', 'types'] },
          },
          {
            name: 'optional',
            in: 'query',
            description:
              'format=types only: optional-property style. exact (default) emits `foo?: T`; undefined emits `foo?: T | undefined`.',
            schema: { type: 'string', enum: ['exact', 'undefined'] },
          },
        ],
        responses: {
          '200': {
            description:
              'Self-contained JSON Schema ($defs-bundled) — or, with format=types, a TypeScript module — served with ETag. ' +
              'JSON responses carry `provenance` (upstream sourceUrl, sourceHash, fetchedAt, extractorVersion) so derivations are independently verifiable. ' +
              '`provenance.derivation` grades how the content was arrived at — `upstream-spec` and `generated` are re-derived every sync and self-heal, while `probe-verified` (confirmed against live API calls on `provenance.verifiedAt`) and `docs-derived` (never confirmed) are point-in-time claims that can go stale.',
            content: {
              'application/json': { schema: { type: 'object' } },
              'text/typescript': { schema: { type: 'string' } },
            },
          },
          '404': errorResponse,
        },
      },
    },
    '/v1/openapi/{provider}': {
      get: {
        operationId: 'getProviderOpenApi',
        summary: 'Generation-only OpenAPI document for one provider',
        description:
          'Assembled from classified endpoints plus the provider connect profile (servers, auth, required headers). ' +
          'Not a raw upstream-spec mirror. Model-grained providers (today: FAL) require ?model=. ' +
          'Selections over 40 classified endpoints, or a filter that matches none, return 400 spec_requires_selector. ' +
          'An unsynced provider returns 404 no_endpoints. ?model= pins the live model enum on provider-grained specs; it does not drop endpoints.',
        parameters: [
          providerParam,
          {
            name: 'model',
            in: 'query',
            description:
              'Pin to one model (raw id or slug). Required for model-grained providers.',
            schema: { type: 'string' },
          },
          {
            name: 'activity',
            in: 'query',
            description: 'Restrict to one activity group.',
            schema: { type: 'string', enum: activityEnum },
          },
        ],
        responses: {
          '200': {
            description: 'OpenAPI 3.1 document.',
            content: {
              'application/openapi+json': { schema: { type: 'object' } },
              'application/json': { schema: { type: 'object' } },
            },
          },
          '400': errorResponse,
          '404': errorResponse,
          '500': errorResponse,
        },
      },
    },
    '/v1/validate': {
      post: {
        operationId: 'validatePayload',
        summary: 'Validate a payload against a provider endpoint schema',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ValidateRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Validation result.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ValidateResult' },
              },
            },
          },
          '400': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/v1/changes': {
      get: {
        operationId: 'listChanges',
        summary: 'Changelog feed (cursor-paginated)',
        description: 'The polling-friendly alternative to webhooks.',
        parameters: [
          {
            name: 'since',
            in: 'query',
            description: 'Unix epoch seconds lower bound.',
            schema: { type: 'integer' },
          },
          { name: 'provider', in: 'query', schema: { type: 'string' } },
          {
            name: 'type',
            in: 'query',
            schema: { type: 'string', enum: changeTypeEnum },
          },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          {
            name: 'wait',
            in: 'query',
            description:
              'Long-poll: hold up to N seconds (cap 60; "30s" form accepted) until new data exists, then return current data.',
            schema: { type: 'string' },
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 200 },
          },
        ],
        responses: {
          '200': {
            description: 'Changes page with next cursor.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/v1/admin/sync/{provider}': {
      post: {
        operationId: 'syncProvider',
        summary: 'Manually trigger a provider spec sync (admin only)',
        parameters: [providerParam],
        security: [{ adminKey: [] }],
        responses: {
          '200': {
            description: 'Sync outcome.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '401': errorResponse,
          '404': errorResponse,
          '502': errorResponse,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      adminKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Admin-Key',
      },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Agent JWT (agent-auth) or API key.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
      ServiceStatus: {
        type: 'object',
        required: ['service', 'time', 'providers'],
        properties: {
          service: { type: 'string', const: 'modelschemas' },
          time: { type: 'integer' },
          providers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                displayName: { type: 'string' },
                status: {
                  type: 'string',
                  enum: ['active', 'degraded', 'disabled', 'pending'],
                },
                lastPolledAt: { type: ['integer', 'null'] },
                lastSyncedAt: { type: ['integer', 'null'] },
                counts: {
                  type: 'object',
                  properties: {
                    models: { type: 'integer' },
                    endpoints: { type: 'integer' },
                    schemas: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
      ValidateRequest: {
        type: 'object',
        required: ['provider', 'endpointId', 'payload'],
        properties: {
          provider: { type: 'string' },
          endpointId: { type: 'string' },
          kind: { type: 'string', enum: ['input', 'output'] },
          payload: {},
        },
      },
      ValidateResult: {
        type: 'object',
        required: ['valid', 'errors'],
        properties: {
          valid: { type: 'boolean' },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                message: { type: 'string' },
                keyword: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const
