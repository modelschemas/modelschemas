import { describe, expect, it } from 'vitest'

import type { DiscoveryDoc } from './gemini.ts'
import { publisherModelDiscovery, vertexOpenApi } from './vertex-spec.ts'

const DOC = {
  title: 'Agent Platform API',
  version: 'v1',
  rootUrl: 'https://aiplatform.googleapis.com/',
  schemas: {
    Request: {
      type: 'object',
      properties: { contents: { $ref: 'Content' } },
    },
    Content: { type: 'object' },
    Unused: { type: 'object' },
  },
  resources: {
    projects: {
      resources: {
        locations: {
          resources: {
            publishers: {
              resources: {
                models: {
                  methods: {
                    generateContent: {
                      id: 'aiplatform.projects.locations.publishers.models.generateContent',
                      flatPath:
                        'v1/projects/{projectsId}/locations/{locationsId}/publishers/{publishersId}/models/{modelsId}:generateContent',
                      httpMethod: 'POST',
                      request: { $ref: 'Request' },
                      response: { $ref: 'Content' },
                    },
                    generateContentAlias: {
                      id: 'aiplatform.publishers.models.generateContent',
                      flatPath:
                        'v1/publishers/{publishersId}/models/{modelsId}:generateContent',
                      httpMethod: 'POST',
                      request: { $ref: 'Request' },
                    },
                  },
                },
              },
            },
            endpoints: {
              methods: {
                generateContent: {
                  id: 'aiplatform.projects.locations.endpoints.generateContent',
                  flatPath:
                    'v1/projects/{projectsId}/locations/{locationsId}/endpoints/{endpointsId}:generateContent',
                  httpMethod: 'POST',
                },
              },
            },
          },
        },
      },
    },
  },
} as DiscoveryDoc

describe('publisherModelDiscovery', () => {
  it('keeps publisher generateContent and the schemas it references', () => {
    const spec = vertexOpenApi(DOC)
    const paths = Object.keys(spec.paths ?? {})
    expect(paths).toEqual([
      '/v1/projects/{projectsId}/locations/{locationsId}/publishers/{publishersId}/models/{modelsId}:generateContent',
    ])
    const schemas = spec.components?.schemas ?? {}
    expect(Object.keys(schemas).sort()).toEqual(['Content', 'Request'])
    const pruned = publisherModelDiscovery(DOC)
    expect(pruned.schemas?.Unused).toBeUndefined()
  })
})
