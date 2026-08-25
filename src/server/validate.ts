/**
 * Payload validation against stored endpoint schemas (PLAN.md task 4.4),
 * using @cfworker/json-schema — built for Workers (ajv's codegen trips
 * CSP/eval restrictions).
 */
import { Validator } from '@cfworker/json-schema'
import { and, eq, isNull } from 'drizzle-orm'
import type { Schema } from '@cfworker/json-schema'

import type { Db } from '#/db/index.ts'
import { schemaVersions } from '#/db/schema.ts'
import { resolveEndpointAlias } from '#/server/schema-binding.ts'

export interface ValidateRequestBody {
  provider: string
  endpointId: string
  kind?: 'input' | 'output'
  payload: unknown
}

export interface ValidationErrorItem {
  path: string
  message: string
  keyword: string
}

export type ValidateOutcome =
  | {
      ok: true
      result: {
        valid: boolean
        errors: Array<ValidationErrorItem>
        provider: string
        endpointId: string
        kind: 'input' | 'output'
        contentHash: string
      }
    }
  | { ok: false; status: number; code: string; message: string }

export function parseValidateBody(raw: unknown): ValidateRequestBody | null {
  if (typeof raw !== 'object' || raw === null) return null
  const body = raw as Record<string, unknown>
  if (typeof body.provider !== 'string' || typeof body.endpointId !== 'string')
    return null
  if (
    body.kind !== undefined &&
    body.kind !== 'input' &&
    body.kind !== 'output'
  )
    return null
  if (!('payload' in body)) return null
  return {
    provider: body.provider,
    endpointId: body.endpointId,
    kind: body.kind,
    payload: body.payload,
  }
}

export async function validatePayload(
  db: Db,
  body: ValidateRequestBody,
): Promise<ValidateOutcome> {
  const kind = body.kind ?? 'input'
  const resolved = await resolveEndpointAlias(
    db,
    body.provider,
    body.endpointId,
  )
  if (!resolved) {
    return {
      ok: false,
      status: 404,
      code: 'unknown_endpoint',
      message: `Unknown endpoint '${body.endpointId}' for provider '${body.provider}'. See GET /v1/schemas/${body.provider} for valid endpoint ids.`,
    }
  }

  const version = await db.query.schemaVersions.findFirst({
    where: and(
      eq(schemaVersions.endpointId, resolved.dbId),
      eq(schemaVersions.kind, kind),
      isNull(schemaVersions.supersededAt),
    ),
  })
  if (!version) {
    return {
      ok: false,
      status: 404,
      code: 'no_schema',
      message: `No current ${kind} schema for endpoint '${resolved.publicId}' (${body.provider}). It may stream binary media or not be synced yet — check GET /v1/schemas/${body.provider}/${resolved.activity}.`,
    }
  }

  const schema = JSON.parse(version.schema) as Schema
  const validator = new Validator(schema, '2020-12', false)
  const result = validator.validate(body.payload)

  return {
    ok: true,
    result: {
      valid: result.valid,
      errors: result.errors.map((e) => ({
        path: e.instanceLocation,
        message: e.error,
        keyword: e.keyword,
      })),
      provider: body.provider,
      endpointId: resolved.publicId,
      kind,
      contentHash: version.contentHash,
    },
  }
}
