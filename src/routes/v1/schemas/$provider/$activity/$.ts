import { createFileRoute } from '@tanstack/react-router'
import { env, waitUntil } from 'cloudflare:workers'

import { getDb } from '#/db/index.ts'
import { activities } from '#/db/schema.ts'
import type { Activity } from '#/db/schema.ts'
import { jsonError } from '#/server/admin.ts'
import { swr } from '#/server/cache.ts'
import { cachedJson, cachedText } from '#/server/http-cache.ts'
import { getEndpointSchema, knownEndpointIds } from '#/server/schemas-api.ts'
import { emitTypesModule, typesEtag } from '#/server/typegen.ts'

export const Route = createFileRoute('/v1/schemas/$provider/$activity/$')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const db = getDb(env)
        if (!(activities as ReadonlyArray<string>).includes(params.activity)) {
          return jsonError(
            404,
            'unknown_activity',
            `Unknown activity '${params.activity}'. Valid activities: ${activities.join(', ')}.`,
          )
        }
        const activity = params.activity as Activity
        const endpointId = params._splat ?? ''
        const url = new URL(request.url)
        const kindParam = url.searchParams.get('kind') ?? 'input'
        if (kindParam !== 'input' && kindParam !== 'output') {
          return jsonError(
            400,
            'invalid_kind',
            `Invalid kind '${kindParam}'. Valid kinds: input, output.`,
          )
        }
        const version = url.searchParams.get('version') ?? undefined
        const format = url.searchParams.get('format') ?? 'json'
        if (format !== 'json' && format !== 'types') {
          return jsonError(
            400,
            'invalid_format',
            `Invalid format '${format}'. Valid formats: json, types.`,
          )
        }
        const optionalStyle = url.searchParams.get('optional') ?? 'exact'
        if (optionalStyle !== 'exact' && optionalStyle !== 'undefined') {
          return jsonError(
            400,
            'invalid_optional',
            `Invalid optional '${optionalStyle}'. Valid styles: exact, undefined.`,
          )
        }

        // Versioned reads are immutable (content-addressed); current reads
        // revalidate on the usual SWR cadence.
        const result = await swr(
          { db, kv: env.SCHEMA_CACHE, waitUntil },
          `schema:${params.provider}:${activity}:${endpointId}:${kindParam}:${version ?? 'current'}`,
          () =>
            getEndpointSchema(
              db,
              params.provider,
              activity,
              endpointId,
              kindParam,
              version,
            ),
          { staleTime: version !== undefined ? 86_400 : 300 },
        )
        if (result.value === null) {
          const valid = await knownEndpointIds(db, params.provider, activity)
          return jsonError(
            404,
            'unknown_schema',
            `No ${kindParam} schema${version ? ` at version '${version}'` : ''} for endpoint '${endpointId}' (${params.provider}/${activity}). ` +
              (valid.length > 0
                ? `Valid endpoint ids: ${valid.join(', ')}.`
                : `No endpoints synced for this provider/activity yet — try POST /v1/admin/sync/${params.provider} or check /v1/status.`),
          )
        }
        if (format === 'types') {
          const schema = result.value.schema
          const text = emitTypesModule({
            provider: params.provider,
            endpointId,
            kind: kindParam,
            contentHash: result.value.contentHash,
            schema:
              typeof schema === 'object' &&
              schema !== null &&
              !Array.isArray(schema)
                ? (schema as Record<string, unknown>)
                : {},
            optionalStyle,
            sourceUrl: `${url.origin}${url.pathname}?kind=${kindParam}`,
          })
          return cachedText(request, text, 'text/typescript; charset=utf-8', {
            etag: typesEtag(result.value.contentHash, optionalStyle),
            fetchedAt: result.fetchedAt,
            staleAt: result.staleAt,
          })
        }
        return cachedJson(request, result.value, {
          etag: result.value.contentHash,
          fetchedAt: result.fetchedAt,
          staleAt: result.staleAt,
        })
      },
    },
  },
})
