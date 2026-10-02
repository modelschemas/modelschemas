# @modelschemas/rate-card

Model pricing as data. A rate card is JSONLogic over a closed op set
(`var`, arithmetic, comparisons, `if`, `and`/`or`, `ceil`/`floor`,
`max`/`min`, plus `lookup` into named tables) with the source page's worked
examples attached. The evaluator refuses instead of coercing: an unknown op,
unbound input, missing table key, non-numeric operand or non-positive price
throws `RateCardError`. A refusal is an honest unknown.

> Ships as TypeScript source; no Cloudflare / Node-specific imports.

```bash
bun add @modelschemas/rate-card
```

```ts
import {
  compileOpenRouterPricing,
  price,
  rateCardSchema,
  verifyExamples,
} from '@modelschemas/rate-card'

const card = rateCardSchema.parse(json)
if (verifyExamples(card).some((r) => !r.ok)) throw new Error('bad card')

// request-bound levers read the body; usage-bound levers read usage
const usd = price(
  card,
  { duration: 5, resolution: '720p' },
  { input_tokens: 1200, output_tokens: 300 },
)

// OpenRouter `pricing` → usage-bound token card (null when it prices nothing)
const tokenCard = compileOpenRouterPricing(model.pricing, {
  url: 'https://openrouter.ai/api/v1/models',
  hash, // sha256 of the priced text
  extractedAt: new Date().toISOString(),
})
```

A number input may carry an `estimate`: the source's published way to
derive it when the caller omits it (Seedance `completion_tokens` from
resolution × ratio × duration), with its own `inputs` and `source`.
`priceDetailed` returns `{ usd, estimated }`; `estimated` lists the params
that were filled that way, so an estimate is never mistaken for the billed
price. Supplying the real value skips the estimate and its inputs. `price`
never estimates: it throws `required` for the omitted input instead.

Token counts on compiled OpenRouter cards are disjoint: `input_tokens`
excludes `cache_read_tokens` / `cache_write_tokens`, `output_tokens`
excludes `reasoning_tokens`. `min_prompt_tokens` overrides become rate
tiers (strictly greater than the threshold); time-window overrides are not
applied (the card quotes the base rate).

Docs: [modelschemas.com/docs](https://modelschemas.com/docs) · Source:
[github.com/modelschemas/modelschemas](https://github.com/modelschemas/modelschemas)
