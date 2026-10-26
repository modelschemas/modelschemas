/**
 * Served shapes that the server also builds as TypeScript values. Each is a
 * zod schema with a `.meta` id: the TS type is inferred from it and
 * `openapi.ts` writes the component from it, so the spec and the types
 * cannot drift. No imports beyond zod and the rate-card schema, so the spec
 * emitter loads it without the server.
 */
import { rateCardSchema } from '@modelschemas/rate-card/schema'
import { z } from 'zod'

/**
 * What a list row says about a stored card. `null` on the row means no
 * card; this means there is one. Token cards carry their per-million rates
 * when those are linear (`tiered` marks a long-prompt re-quote above some
 * threshold — the rates shown are the base); everything else names the
 * unit it bills by and points at the full card. `currency` is the
 * ISO-4217 code the rates are in; rows in different currencies do not
 * compare.
 */
export const compactPricingSchema = z
  .object({
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .meta({
        description:
          'ISO-4217 code the rates are in. Rows in different currencies do not compare; nothing is converted.',
      }),
    per: z.enum(['token', 'second', 'character', 'image', 'request', 'unit']),
    inputPerMillion: z.number().optional(),
    outputPerMillion: z.number().optional(),
    tiered: z.literal(true).optional(),
  })
  .meta({
    id: 'CompactPricing',
    description:
      'List-row summary of a stored rate card. per=token cards carry per-million rates at the base tier (tiered marks a long-prompt re-quote above some threshold; fetch the card for it). Other values name the unit the card bills by; the full card is on the detail route or ?pricing=1.',
  })
export type CompactPricing = z.infer<typeof compactPricingSchema>

const priceBoundsSchema = z
  .object({ min: z.number(), max: z.number() })
  .meta({ id: 'PriceBounds' })

/**
 * Null unless every route has a linear token card in one currency: a
 * route with no card, a tier, or a different currency leaves the bounds
 * unknown.
 */
export const pricingRangeSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    routes: z.array(
      z.object({
        model: z.string().meta({
          description:
            "The route's catalog rawId, or its gateway provider name when card is inline.",
        }),
        provider: z.string().optional().meta({
          description:
            'Gateway route name (Vercel `provider_name`) when card is stored on this route instead of a catalog row.',
        }),
        card: rateCardSchema.optional().meta({
          description:
            'Compiled card for a route with no catalog row. Estimate prices this card. Absent when model names a row. `examples` is empty so the catalog response stays serializable.',
        }),
        pricing: compactPricingSchema,
      }),
    ),
    inputPerMillion: priceBoundsSchema,
    outputPerMillion: priceBoundsSchema.optional(),
  })
  .meta({
    id: 'PricingRange',
    description:
      'A routed model id with no single billed price: the gateway picks one route per call, and each route bills its own published card. min/max are bounds over those cards, never the billed price. A route is either its own model row under the same provider (model is that rawId) or, when the gateway has no per-route row, a provider name with the compiled card inline. POST /v1/estimate on this row prices the call on every route and returns min and max.',
  })
type PricingRangeShape = z.infer<typeof pricingRangeSchema>

/**
 * A route's inline card is built with no examples. Typing that as `[]` keeps
 * the catalog response serializable through TanStack server functions, which
 * refuse the `unknown` in an example's `params`.
 */
export type PricingRange = Omit<PricingRangeShape, 'routes'> & {
  routes: Array<
    Omit<PricingRangeShape['routes'][number], 'card'> & {
      card?: Omit<
        NonNullable<PricingRangeShape['routes'][number]['card']>,
        'examples'
      > & {
        examples: []
      }
    }
  >
}

/**
 * `models.reasoning`. The cross-field rules (a toggle is never stored with
 * `mandatory` null, takes no efforts, and so on) live in
 * `reasoningViolation` in `providers/types.ts`, which gates every poll
 * write; the full rules are on `ModelReasoning` there.
 */
export const modelReasoningSchema = z
  .object({
    mode: z.enum(['adaptive', 'budget', 'effort', 'toggle']),
    mandatory: z.boolean().nullable(),
    efforts: z.array(z.string()).optional(),
  })
  .meta({ id: 'ModelReasoning' })
export type ModelReasoning = z.infer<typeof modelReasoningSchema>

/** Shared effort levels to the value this model accepts. null omits it. */
export const effortLevelMapSchema = z.object({
  off: z.string().nullable(),
  minimal: z.string().nullable(),
  low: z.string().nullable(),
  medium: z.string().nullable(),
  high: z.string().nullable(),
  xhigh: z.string().nullable(),
  max: z.string().nullable(),
})
export type EffortLevelMap = z.infer<typeof effortLevelMapSchema>

/**
 * How a caller turns a shared chat intent into one provider's request body
 * (issue #95). `reasoning` stays the readable fact. This object is the wire
 * map. Unverified providers and non-chat rows are null — no guessed body.
 * Unverified flags inside a verified map are null, not a default.
 */
export const chatRequestMapSchema = z.object({
  thinking: z
    .object({
      /** Request body for "thinking on, effort high". */
      on: z.record(z.string(), z.unknown()).meta({
        description: 'Request body for thinking on at effort high.',
      }),
      /** Explicit off, when silence would make the model think. */
      off: z.record(z.string(), z.unknown()).nullable().meta({
        description:
          'Request body that turns thinking off, or null when silence is off.',
      }),
      /** Shared levels → the value this model accepts. null when unverified. */
      levels: effortLevelMapSchema.nullable().meta({
        description:
          'Shared effort levels to the value this model accepts. null omits the field. The object itself is null when the subset is unverified.',
      }),
    })
    .nullable(),
  maxTokensField: z.enum(['max_completion_tokens', 'max_tokens']).nullable(),
  /** True when the model wants `role: "developer"`; false when it rejects it. */
  developerRole: z.boolean().nullable(),
  replayReasoningContent: z.boolean().nullable(),
  store: z.boolean().nullable(),
  strictTools: z.boolean().nullable(),
  sessionAffinity: z.boolean().nullable(),
  cacheControl: z.literal('anthropic').nullable(),
  toolStream: z.boolean().nullable(),
  /** False when the provider rejects a top-level `reasoning_effort` field. */
  reasoningEffort: z.boolean().nullable(),
})
export type ChatRequestMap = z.infer<typeof chatRequestMapSchema>
export type ThinkingRequest = NonNullable<ChatRequestMap['thinking']>

/**
 * The served component. A stored map from before a flag existed lacks that
 * key, so the spec leaves every key optional; the server always builds the
 * full `ChatRequestMap`.
 */
export const servedChatRequestMapSchema = chatRequestMapSchema.partial().meta({
  id: 'ChatRequestMap',
  description:
    'Verified chat request wire map. A null field is unverified, not a guess. thinking.levels null means the level subset is unverified; a null level value means omit that field.',
})
