/**
 * Served shapes that the server also builds as TypeScript values. Each is a
 * zod schema with a `.meta` id: the TS type is inferred from it and
 * `openapi.ts` writes the component from it, so the spec and the types
 * cannot drift. Every field carries a `description` because agents read the
 * served schema. No imports beyond zod and the rate-card schema, so the spec
 * emitter loads it without the server.
 */
import { rateCardSchema } from '@modelschemas/rate-card/schema'
import { z } from 'zod'

const currencyCode = z.string().regex(/^[A-Z]{3}$/)

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
    currency: currencyCode.meta({
      description:
        'ISO-4217 code the rates are in. Rows in different currencies do not compare; nothing is converted.',
    }),
    per: z
      .enum(['token', 'second', 'character', 'image', 'request', 'unit'])
      .meta({
        description:
          'The unit the card bills by. token: inputPerMillion and outputPerMillion are set when the rates are linear. Every other value: fetch the full card.',
      }),
    inputPerMillion: z.number().optional().meta({
      description:
        'Price per million input tokens at the base tier, in `currency`. per=token only.',
    }),
    outputPerMillion: z.number().optional().meta({
      description:
        'Price per million output tokens at the base tier, in `currency`. per=token only.',
    }),
    tiered: z.literal(true).optional().meta({
      description:
        'Present when the card re-quotes the rates above some prompt-length threshold. The rates shown are the base tier; fetch the card for the rest.',
    }),
  })
  .meta({
    id: 'CompactPricing',
    description:
      'List-row summary of a stored rate card. per=token cards carry per-million rates at the base tier (tiered marks a long-prompt re-quote above some threshold; fetch the card for it). Other values name the unit the card bills by; the full card is on the detail route or ?pricing=1.',
  })
export type CompactPricing = z.infer<typeof compactPricingSchema>

const priceBoundsSchema = z
  .object({
    min: z.number(),
    max: z.number(),
  })
  .meta({
    id: 'PriceBounds',
    description:
      'A bound over route prices, per million tokens: never the billed price.',
  })

/**
 * Null unless every route has a linear token card in one currency: a
 * route with no card, a tier, or a different currency leaves the bounds
 * unknown.
 */
export const pricingRangeSchema = z
  .object({
    currency: currencyCode.meta({
      description:
        'ISO-4217 code every route is priced in. A range is only built when the routes share one.',
    }),
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
            'Compiled card for a route with no catalog row. Estimate prices this card. Absent when model names a row. Its `examples` is empty.',
        }),
        pricing: compactPricingSchema,
      }),
    ),
    inputPerMillion: priceBoundsSchema.meta({
      description: "Bounds over the routes' input price per million tokens.",
    }),
    outputPerMillion: priceBoundsSchema.optional().meta({
      description:
        "Bounds over the routes' output price per million tokens, when every route states one.",
    }),
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
    mode: z.enum(['adaptive', 'budget', 'effort', 'toggle']).meta({
      description:
        'The one control the request exposes. adaptive: the model decides (Anthropic thinking.type adaptive, or a switch with an auto value). budget: a token budget (thinking.budget_tokens, Gemini thinkingBudget). effort: a level (reasoning_effort, Gemini thinkingLevel). toggle: an on/off switch and nothing else (thinking.type enabled|disabled, enable_thinking); it says nothing about the default when the field is omitted.',
    }),
    mandatory: z.boolean().nullable().meta({
      description:
        "true: the provider states thinking cannot be turned off for this model (on a toggle: the off value is rejected, so send on or omit the field). false: the provider states it can be, in prose or by an off value in this model's own schema or level list. null: unstated; do not read it as false, test mandatory === false before offering an off option. A toggle is never stored with null.",
    }),
    efforts: z.array(z.string()).optional().meta({
      description:
        'The accepted effort values as published, an off value such as none included. Never present on a toggle.',
    }),
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
      on: z.record(z.string(), z.unknown()).meta({
        description: 'Request body for thinking on at effort high.',
      }),
      off: z.record(z.string(), z.unknown()).nullable().meta({
        description:
          'Request body that turns thinking off, or null when silence is off (the model does not think unless asked).',
      }),
      levels: effortLevelMapSchema.nullable().meta({
        description:
          'Shared effort levels to the value this model accepts. null omits the field. The object itself is null when the subset is unverified.',
      }),
    })
    .nullable(),
  maxTokensField: z
    .enum(['max_completion_tokens', 'max_tokens'])
    .nullable()
    .meta({
      description: 'Name of the request field that caps output tokens.',
    }),
  developerRole: z.boolean().nullable().meta({
    description:
      'true when the model wants `role: "developer"` instead of `system`; false when it rejects it.',
  }),
  replayReasoningContent: z.boolean().nullable().meta({
    description:
      "true when the provider needs the previous turn's `reasoning_content` replayed on the assistant message.",
  }),
  store: z.boolean().nullable(),
  strictTools: z.boolean().nullable(),
  sessionAffinity: z.boolean().nullable(),
  cacheControl: z.literal('anthropic').nullable(),
  toolStream: z.boolean().nullable().meta({
    description:
      'true when the model takes `tool_stream: true` alongside `stream: true` (Z.AI GLM). null: unverified.',
  }),
  reasoningEffort: z.boolean().nullable().meta({
    description:
      'false when the provider rejects a top-level `reasoning_effort` field.',
  }),
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
